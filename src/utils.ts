import { S3Settings, GithubSettings } from './settings';
import * as mime from 'mime-types';
import * as path from 'path';
import * as crypto from 'crypto';
import S3 from 'aws-sdk/clients/s3';
import { GitlabHelper } from './gitlabHelper';

import { warn, error, debug } from 'loglevel';
import * as fs from 'fs';
import { INPUTS_OUTPUTS_DIR } from './intput-output-files';
import settings from '../settings';

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
  filePath: fs.PathLike;
};

export type AttachmentsByRepository = Record<string, { repoUrl: string, uniqueGitTag: string, attachments: Array<Attachment> }>;
let openFileHandles = 0;
export const getOpenFileHandles = () => openFileHandles;
const attachments: AttachmentsByRepository = {};

export async function writeAttachmentsInfoToDisk(targetPath: string) {
  await fs.promises.writeFile(targetPath, JSON.stringify(attachments, null, 2));
  console.debug(`Updated attachments file at ${targetPath}`);
}

function transformToApiDownloadUrl(relUrl: string, gitlabProjectId: string | number) {
  const relUrlParts = relUrl.split('/');
  const fileName = relUrlParts[relUrlParts.length - 1];
  const secret = relUrlParts[relUrlParts.length - 2];
  let projectId = relUrlParts[relUrlParts.length - 4] || gitlabProjectId.toString();

  const transformedUrl = `${projectId}/uploads/${secret}/${fileName}`;
  console.debug(`Transformed URL: from ${relUrl} to ${transformedUrl}`);
  return `${projectId}/uploads/${secret}/${fileName}`
}

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
      const targetBasePath = '.github-migration/attachments';
      const { repoId, repoUrl, uniqueGitTag, attachmentUrl, targetPath, outputFilePath } = createattachmentInfo({ targetBasePath, fileName: fileBasename, sourceFileUrl: url, githubOwner, githubRepo });
      const data = await gitlabHelper.getAttachment(attachmentUrlRel, true);
      if (data) {
        saveToDisk(outputFilePath, data);
        updateattachments({ repoId, repoUrl, uniqueGitTag, attachment: { attachmentUrl, targetPath, filePath: outputFilePath }, attachments });
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

  function updateattachments({ repoId, repoUrl, uniqueGitTag, attachment, attachments }: { repoId: string, repoUrl: string, uniqueGitTag: string, attachment: Attachment, attachments: AttachmentsByRepository }) {
    if (!attachments[repoId]) {
      const attachmentInfo = { repoUrl, uniqueGitTag, attachments: [attachment] };
      attachments[repoId] = attachmentInfo
    } else {
      attachments[repoId].attachments.push(attachment);
    }
  }

  function createattachmentInfo({ targetBasePath, fileName, sourceFileUrl, githubOwner, githubRepo }: { targetBasePath: string, fileName: string, sourceFileUrl: string, githubOwner: string, githubRepo: string }) {
    const repoUrl = `https://github.com/${githubOwner}/${githubRepo}.git`.replace(/\.git\/?$/, '.git');
    const repoId = generateHash(repoUrl);
    const uniqueGitTag = `attachments-from-gitlab-${repoId}`;
    
    const fileHashMatch = /\/uploads\/([^/]+)\//.exec(sourceFileUrl);
    if (!fileHashMatch) {
      throw new Error(`Failed to determine file hash from URL: ${sourceFileUrl}`);
    }

    const fileHash = fileHashMatch[1];
    const hashPlusName = `${fileHash}-${fileName}`;
    const targetPath = `${targetBasePath}/${repoId}/${hashPlusName}`;
    const repoName = githubRepo;
    const repoPath = `${repoName}-${repoId}`;
    const outputFilePath = path.join(INPUTS_OUTPUTS_DIR, 'attachments', repoPath, hashPlusName);
    const attachmentUrl = `https://github.com/${githubOwner}/${githubRepo}/blob/${uniqueGitTag}/${targetPath}?raw=true`;

    return { repoId, repoUrl, uniqueGitTag, attachmentUrl, targetPath, outputFilePath };
  }

};
async function saveToDisk(outputFilePath: string, dataStream: fs.ReadStream) {
  await fs.promises.mkdir(path.dirname(outputFilePath), { recursive: true });
  const writeStream = fs.createWriteStream(outputFilePath);
  dataStream.pipe(writeStream);
  dataStream.on('error', () => { writeStream.close(); console.error(`Failed to read attachment stream`) });
  dataStream.on('end', () => console.debug(`Finished reading attachment stream`));
  writeStream.on('open', () => openFileHandles++);
  writeStream.on('close', () => openFileHandles--);
  writeStream.on('finish', () => {
    console.debug(`Finished writing attachment to ${outputFilePath}`);
  });
  writeStream.on('error', () => { writeStream.close(); console.error(`Failed to write attachment to ${outputFilePath}`) });
}

function generateHash(stringToHash: string) {
  const hash = crypto.createHash('md5');
  hash.update(stringToHash);

  return hash.digest('hex');
}
