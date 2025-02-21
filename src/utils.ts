import { S3Settings, GithubSettings } from './settings';
import * as mime from 'mime-types';
import * as path from 'path';
import * as crypto from 'crypto';
import S3 from 'aws-sdk/clients/s3';
import { GitlabHelper } from './gitlabHelper';

import { warn, error, debug } from 'loglevel';
import settings from '../settings';
import * as attachmentsHandler from './attachmentsHandler';
import { Readable } from 'stream';

const console = {
  log: warn,
  error,
  debug,
}

export const sleep = (milliseconds: number) => {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
};

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

