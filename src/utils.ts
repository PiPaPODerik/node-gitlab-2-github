import { S3Settings, GithubSettings } from './settings';
import * as mime from 'mime-types';
import * as path from 'path';
import * as crypto from 'crypto';
import S3 from 'aws-sdk/clients/s3';
import { GitlabHelper } from './gitlabHelper';

import { warn, error, debug } from 'loglevel';
import * as fs from 'fs';
import { ATTACHMENTS_FILE_PATH, OUTPUT_DIR } from './constants';

const console = {
  log: warn,
  error,
  debug,
}

export const sleep = (milliseconds: number) => {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
};
interface Attachment {
  attachmentUrl: string;
  targetPath: string;
  binaryData: Buffer;
};

export type AttachmentsByRepository = Record<string, { repoUrl: string, uniqueGitTag: string, attachments: Array<Attachment> }>;

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
    const basename = path.basename(url);
    const attachmentBuffer = await gitlabHelper.getAttachment(url);
    const attachments: AttachmentsByRepository = {};

    if (s3 && s3.bucket) {
      const mimeType = mime.lookup(basename);
      if (!attachmentBuffer) {
        continue;
      }

      // // Generate file name for S3 bucket from URL
      const hash = crypto.createHash('sha256');
      hash.update(url);
      const newFileName = hash.digest('hex') + '/' + basename;
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
          console.log(`\tUploading ${basename} to ${s3url}... `);
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
      // Not using S3: default to old URL, adding absolute path
      if (!attachmentBuffer) {
        console.error(`Failed to get attachment for URL: ${url}`);
        continue;
      }
      
      const targetBasePath = '.github-migration/attachments';
      const { repoId, repoUrl, uniqueGitTag, attachmentUrl, targetPath} = createattachmentInfo(targetBasePath, basename, attachmentBuffer);
      updateattachments({ repoId, repoUrl, uniqueGitTag, attachment: { attachmentUrl, targetPath, binaryData: attachmentBuffer }, attachments });

      offsetToAttachment[
        match.index as number
      ] = `${prefix}[${name}](${attachmentUrl})`;
    }

    await updateAttachmentOutput(attachments);
  }

  return body.replace(
    regexp,
    ({ }, { }, { }, { }, offset, { }) => offsetToAttachment[offset]
  );

  function updateattachments({ repoId, repoUrl, uniqueGitTag, attachment, attachments }: { repoId: string, repoUrl: string, uniqueGitTag: string, attachment: Attachment, attachments: AttachmentsByRepository }) {
    if (!attachments[repoId]) {
      const attachmentInfo = { repoUrl, uniqueGitTag, attachments: [attachment] };
      attachments[repoId] = attachmentInfo
    } else {
      attachments[repoId].attachments.push(attachment);
    }
  }

  function createattachmentInfo(targetBasePath: string, basename: string, attachmentBuffer: Buffer) {
    const repoUrl = `https://github.com/${githubOwner}/${githubRepo}.git`.replace(/\.git\/?$/, '.git');
    const repoId = generateHash(repoUrl);
    const uniqueGitTag = `attachments-from-gitlab-${repoId}`;
    const targetPath = `${targetBasePath}/${repoId}/${basename}`;
    const attachmentUrl = `https://github.com/${githubOwner}/${githubRepo}/blob/${uniqueGitTag}/${targetPath}?raw=true`;

    return { repoId, repoUrl, uniqueGitTag, attachmentUrl, targetPath };
  }

  function generateHash(stringToHash: string) {
    const hash = crypto.createHash('md5');
    hash.update(stringToHash);
    const uniqueHash = hash.digest('hex');
    return uniqueHash;
  }
};
async function updateAttachmentOutput(attachmentsByRepo: AttachmentsByRepository) {

  if (!fs.existsSync(OUTPUT_DIR)) {
    throw new Error(`Output directory ${OUTPUT_DIR} does not exist.`);
  }

  let existingAttachments: AttachmentsByRepository = {};
  if (fs.existsSync(ATTACHMENTS_FILE_PATH)) {
    const fileContent = await fs.promises.readFile(ATTACHMENTS_FILE_PATH, 'utf-8');
    existingAttachments = JSON.parse(fileContent);
  }

  for (const [repoId, attachmentsInfo] of Object.entries(attachmentsByRepo)) {
    const existingAttachment = existingAttachments[repoId];
    if (existingAttachment) {
      existingAttachment.attachments.push(...attachmentsInfo.attachments);
    } else {
      existingAttachments[repoId] = attachmentsInfo;
    }
  }

  await fs.promises.writeFile(ATTACHMENTS_FILE_PATH, JSON.stringify(existingAttachments, null, 2));
  console.debug(`Updated attachments file at ${ATTACHMENTS_FILE_PATH}`);
}

