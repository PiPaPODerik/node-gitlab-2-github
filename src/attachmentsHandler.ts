import * as fs from 'fs';
import path from 'path';
import { INPUTS_OUTPUTS_DIR } from './intput-output-files';
import * as crypto from 'crypto';

export {
  createattachmentInfo,
  updateAttachments,
  saveToDisk,
  generateHash,
  getOpenFileHandles,
  writeAttachmentsInfoToDisk,
  Attachment,
  AttachmentsByRepository,
  attachments,
  defaultTargetBasePath,
}
interface Attachment {
  attachmentUrl: string;
  targetPath: string;
  filePath: fs.PathLike;
};

type AttachmentsByRepository = Record<string, { repoUrl: string, uniqueGitTag: string, attachments: Array<Attachment> }>;
const filehandles = { open: 0 };
const getOpenFileHandles = () => ({ ...filehandles }).open;
const attachments: AttachmentsByRepository = {};
const defaultTargetBasePath = '.github-migration/attachments';

function updateAttachments({ repoId, repoUrl, uniqueGitTag, attachment }: { repoId: string, repoUrl: string, uniqueGitTag: string, attachment: Attachment }) {
  if (!attachments[repoId]) {
    const attachmentInfo = { repoUrl, uniqueGitTag, attachments: [attachment] };
    attachments[repoId] = attachmentInfo
  } else {
    attachments[repoId].attachments.push(attachment);
  }
}

function createattachmentInfo({ fileName, fileHash, githubOwner, githubRepo, targetBasePath = defaultTargetBasePath }: { fileName: string, fileHash: string, githubOwner: string, githubRepo: string, targetBasePath?: string }) {
  const repoUrl = `https://github.com/${githubOwner}/${githubRepo}.git`.replace(/\.git\/?$/, '.git');
  const repoId = generateHash(repoUrl);
  const uniqueGitTag = `attachments-from-gitlab-${repoId}`;

  const hashPlusName = `${fileHash}-${fileName}`;
  const targetPath = `${targetBasePath}/${repoId}/${hashPlusName}`;
  const repoName = githubRepo;
  const repoPath = `${repoName}-${repoId}`;
  const outputFilePath = path.join(INPUTS_OUTPUTS_DIR, 'attachments', repoPath, hashPlusName);
  const attachmentUrl = `https://github.com/${githubOwner}/${githubRepo}/blob/${uniqueGitTag}/${targetPath}?raw=true`;

  return { repoId, repoUrl, uniqueGitTag, attachmentUrl, targetPath, outputFilePath };
}


async function saveToDisk(outputFilePath: string, dataStream: NodeJS.ReadableStream) {
  await fs.promises.mkdir(path.dirname(outputFilePath), { recursive: true });
  const writeStream = fs.createWriteStream(outputFilePath);
  dataStream.pipe(writeStream);
  dataStream.on('error', () => { writeStream.close(); console.error(`Failed to read attachment stream`) });
  dataStream.on('end', () => console.debug(`Finished reading attachment stream`));
  writeStream.on('open', () => filehandles.open++);
  writeStream.on('close', () => filehandles.open--);
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

async function writeAttachmentsInfoToDisk(targetPath: string) {
  await fs.promises.writeFile(targetPath, JSON.stringify(attachments, null, 2));
  console.debug(`Updated attachments file at ${targetPath}`);
}
