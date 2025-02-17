const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const inputOutputVarValid = process.env.G2H_INPUTS_OUTPUTS_DIR !== undefined && process.env.G2H_INPUTS_OUTPUTS_DIR !== '' && process.env.G2H_INPUTS_OUTPUTS_DIR !== null;
const inputsOutputsDir = inputOutputVarValid ? process.env.G2H_INPUTS_OUTPUTS_DIR : '../inputs-outputs';
const settingsFileSourcePath = path.join(inputsOutputsDir, './settings.ts');

const envFile = path.resolve('.env');
const nodeArgs = fs.existsSync(envFile) ? `--env-file=${envFile}` : '';

if (!inputOutputVarValid && !nodeArgs.includes('G2H_INPUTS_OUTPUTS_DIR')) {
  console.log(`Environment variable G2H_INPUTS_OUTPUTS_DIR is not set. Using default inputs-outputs dir ${settingsFileSourcePath}.`);
}

if (fs.existsSync(settingsFileSourcePath)) {
  console.log(`Using settings file: ${settingsFileSourcePath}`);
} else {
  throw new Error(`Settings file not found: ${settingsFileSourcePath} ...Aborting.`);
}

if (path.dirname(settingsFileSourcePath) !== __dirname) {
  const destinationPath = path.join(__dirname, path.basename(settingsFileSourcePath));
  fs.copyFileSync(settingsFileSourcePath, destinationPath);
  console.log(`Copied settings file from ${settingsFileSourcePath} to: ${destinationPath}`);
}

const tsNodeRegister = '-r ts-node/register';

const script = process.argv[2];
const command = `node ${nodeArgs} ${tsNodeRegister} ${script}`;

execSync(command, { stdio: 'inherit' });