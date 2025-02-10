const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const inputsOutputsDir = process.env.G2H_INPUTS_OUTPUTS_DIR || './inputs-outputs';
const settingsFilePath = process.env.G2H_INPUTS_OUTPUTS_DIR ? path.join(inputsOutputsDir, './settings.ts') : path.join(__dirname, './settings.ts');

const envFile = path.resolve('.env');
const nodeArgs = fs.existsSync(envFile) ? `--env-file=${envFile}` : '';

if (!process.env.G2H_INPUTS_OUTPUTS_DIR && !nodeArgs.includes('G2H_INPUTS_OUTPUTS_DIR')) {
  console.log(`Environment variable G2H_INPUTS_OUTPUTS_DIR is not set. Using default inputs-outputs dir ${settingsFilePath}.`);
}

if (fs.existsSync(settingsFilePath)) {
  console.log(`Using settings file: ${settingsFilePath}`);
} else {
  throw new Error(`Settings file not found: ${settingsFilePath} ...Aborting. Please provide the path to settings.ts`);
}

if (path.dirname(settingsFilePath) !== path.parse(__dirname).dir) {
  const destinationPath = path.join(__dirname, path.basename(settingsFilePath));
  fs.copyFileSync(settingsFilePath, destinationPath);
  console.log(`Copied settings file from ${settingsFilePath} to: ${destinationPath}`);
}

const tsNodeRegister = '-r ts-node/register';

const script = process.argv[2];
const command = `node ${nodeArgs} ${tsNodeRegister} ${script}`;

execSync(command, { stdio: 'inherit' });