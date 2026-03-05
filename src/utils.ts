import { S3Settings, GithubSettings } from './settings';

import * as mime from 'mime-types';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import S3 from 'aws-sdk/clients/s3';
import { GitlabHelper } from './gitlabHelper';

import { warn, error, debug } from 'loglevel';
import settings from '../settings';
import * as attachmentsHandler from './attachmentsHandler';
import { Readable } from 'stream';

export const sleep = (milliseconds: number) => {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
};

/**
 * Configuration for retry behavior
 */
export interface RetryConfig {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryableStatusCodes?: number[];
  shouldRetry?: (error: any) => boolean;
}

/**
 * Default retry configuration
 */
const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 32000,
  retryableStatusCodes: [429, 500, 502, 503, 504],
  shouldRetry: (error: any) => {
    const status = error?.status || error?.response?.status || error?.statusCode;
    return DEFAULT_RETRY_CONFIG.retryableStatusCodes.includes(status);
  }
};

/**
 * Calculate delay with exponential backoff and jitter
 * @param attempt - The current attempt number (0-indexed)
 * @param baseDelayMs - Base delay in milliseconds
 * @param maxDelayMs - Maximum delay in milliseconds
 * @returns Delay in milliseconds
 */
function calculateDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  // Exponential backoff: baseDelay * 2^attempt
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);

  // Cap at maxDelay
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

  // Add jitter: random value between 0 and cappedDelay
  const jitter = Math.random() * cappedDelay;

  return jitter;
}

/**
 * Retry a function with exponential backoff and jitter
 * Handles HTTP status codes 429, 500, 502, 503, 504 by default
 * 
 * @param fn - The async function to retry
 * @param config - Retry configuration
 * @returns The result of the function call
 * 
 * @example
 * const result = await retryWithBackoff(
 *   async () => await githubApi.issues.create(params),
 *   { maxRetries: 3, baseDelayMs: 1000 }
 * );
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  config: RetryConfig = {}
): Promise<T> {
  const mergedConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
  const { maxRetries, baseDelayMs, maxDelayMs, shouldRetry } = mergedConfig;

  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      // Check if we should retry this error
      if (!shouldRetry(error)) {
        throw error;
      }

      // If this was the last attempt, throw the error
      if (attempt === maxRetries) {
        throw error;
      }

      // Calculate delay and wait
      const delay = calculateDelay(attempt, baseDelayMs, maxDelayMs);
      const status = error?.status || error?.response?.status || error?.statusCode;

      console.warn(
        `Request failed with status ${status}. Retrying in ${Math.round(delay)}ms... ` +
        `(attempt ${attempt + 1}/${maxRetries})`
      );

      await sleep(delay);
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError;
}

export const readProjectsFromCsv = (
  filePath: string,
  idColumn: number = 0,
  gitlabPathColumn: number = 1,
  githubPathColumn: number = 2
): Map<number, [string, string]> => {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`CSV file not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const projectMap = new Map<number, [string, string]>();
    let headerSkipped = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (!line || line.startsWith('#')) {
        continue;
      }

      const values = line.split(',').map(v => v.trim());
      const maxColumn = Math.max(idColumn, gitlabPathColumn, githubPathColumn);

      if (maxColumn >= values.length) {
        console.warn(`Warning: Line ${i + 1} has only ${values.length} column(s), skipping (need column ${maxColumn})`);
        if (!headerSkipped) {
          headerSkipped = true;
        }
        continue;
      }

      const idStr = values[idColumn];
      const gitlabPath = values[gitlabPathColumn];
      const githubPath = values[githubPathColumn];

      if (!headerSkipped) {
        const num = parseInt(idStr, 10);
        if (isNaN(num) || idStr.toLowerCase().includes('id') || idStr.toLowerCase().includes('project')) {
          console.log(`Skipping CSV header row: "${line}"`);
          headerSkipped = true;
          continue;
        }
        headerSkipped = true;
      }

      if (!idStr || !gitlabPath || !githubPath) {
        console.warn(`Warning: Line ${i + 1} has empty values, skipping`);
        continue;
      }

      const projectId = parseInt(idStr, 10);
      if (isNaN(projectId)) {
        console.warn(`Warning: Line ${i + 1}: Invalid project ID "${idStr}", skipping`);
        continue;
      }

      projectMap.set(projectId, [gitlabPath, githubPath]);
    }

    if (projectMap.size === 0) {
      throw new Error(`No valid project mappings found in CSV file: ${filePath}`);
    }

    console.log(`✓ Loaded ${projectMap.size} project mappings from CSV`);
    return projectMap;
  } catch (err) {
    console.error(`Error reading project mapping CSV file: ${err.message}`);
    throw err;
  }
};

function transformToApiDownloadUrl(relUrl: string, gitlabProjectId: string | number) {
  const relUrlParts = relUrl.split('/');
  const fileName = relUrlParts[relUrlParts.length - 1];
  const secret = relUrlParts[relUrlParts.length - 2];
  let projectId = relUrlParts[relUrlParts.length - 4] || gitlabProjectId.toString();

  const transformedUrl = `${projectId}/uploads/${secret}/${fileName}`;
  console.debug(`Transformed URL: from ${relUrl} to ${transformedUrl}`);
  return `${projectId}/uploads/${secret}/${fileName}`
};

// Creates new attachments and replaces old links
export const migrateAttachments = async (
  body: string,
  githubRepoId: number | undefined,
  s3: S3Settings | undefined,
  gitlabHelper: GitlabHelper,
  githubOwner: GithubSettings['owner'],
  githubRepo: GithubSettings['repo']
) => {
  const regexp = /(!?)\[([^\]]+)\]\((\/uploads[^)]+)\)/g;
  // Maps link offset to a new name in S3
  const offsetToAttachment: {
    [key: number]: string;
  } = {};

  // Find all local links
  const matches = body.matchAll(regexp);

  for (const match of matches) {
    const prefix = match[1] || '';
    const name = match[2];
    const url = match[3];
    const fileBasename = path.basename(url);
    const attachmentUrlRel = transformToApiDownloadUrl(url, settings.gitlab.projectId);

    if (s3 && s3.bucket) {
      const mimeType = mime.lookup(fileBasename);
      const attachmentBuffer = await gitlabHelper.getAttachment(attachmentUrlRel);
      if (!attachmentBuffer) {
        continue;
      }

      // // Generate file name for S3 bucket from URL
      const hash = crypto.createHash('sha256');
      hash.update(url);
      const newFileName = hash.digest('hex') + '/' + fileBasename;
      const relativePath = githubRepoId
        ? `${githubRepoId}/${newFileName}`
        : newFileName;
      // Doesn't seem like it is easy to upload an issue to github, so upload to S3
      //https://stackoverflow.com/questions/41581151/how-to-upload-an-image-to-use-in-issue-comments-via-github-api

      // Attempt to fix issue #140
      //const s3url = `https://${s3.bucket}.s3.amazonaws.com/${relativePath}`;
      let hostname = `${s3.bucket}.s3.amazonaws.com`;
      if (s3.region) {
        hostname = `s3.${s3.region}.amazonaws.com/${s3.bucket}`;
      }
      const s3url = `https://${hostname}/${relativePath}`;

      const s3bucket = new S3();
      s3bucket.createBucket(() => {
        const params: S3.PutObjectRequest = {
          Key: relativePath,
          Body: attachmentBuffer,
          ContentType: mimeType === false ? undefined : mimeType,
          Bucket: s3.bucket,
        };

        s3bucket.upload(params, function (err, data) {
          console.log(`\tUploading ${fileBasename} to ${s3url}... `);
          if (err) {
            console.log('ERROR: ', err);
          } else {
            console.log(`\t...Done uploading`);
          }
        });
      });

      // Add the new URL to the map
      offsetToAttachment[
        match.index as number
      ] = `${prefix}[${name}](${s3url})`;
    } else {
      const fileHash = /\/uploads\/([^/]+)\//.exec(url)?.[1];
      if (!fileHash) {
        throw new Error(`Failed to determine file hash from URL: ${url}`);
      }
      const { repoId, repoUrl, uniqueGitTag, attachmentUrl, targetPath, outputFilePath } = attachmentsHandler.createattachmentInfo({ fileName: fileBasename, fileHash, githubOwner, githubRepo });
      const data = await gitlabHelper.getAttachment(attachmentUrlRel, true);
      if (data) {
        attachmentsHandler.saveToDisk(outputFilePath, data as Readable);
        attachmentsHandler.updateAttachments({ repoId, repoUrl, uniqueGitTag, attachment: { attachmentUrl, targetPath, filePath: outputFilePath } });
      } else {
        console.error(`Failed to get attachment stream for URL: ${url}`);
      }

      offsetToAttachment[
        match.index as number
      ] = `${prefix}[${name}](${attachmentUrl})`;
    }
  }

  return body.replace(
    regexp,
    ({ }, { }, { }, { }, offset, { }) => offsetToAttachment[offset]
  );
};

export const organizationUsersString = (users: string[], prefix: string): string => {
  let organizationUsers = [];
  for (let assignee of users) {
    let githubUser = settings.usermap[assignee as string];
    if (githubUser) {
      githubUser = '@' + githubUser;
    } else {
      githubUser = assignee as string;
    }
    organizationUsers.push(githubUser);
  }

  if (organizationUsers.length > 0) {
    return `\n\n**${prefix}:** ` + organizationUsers.join(', ');
  }

  return '';
}
