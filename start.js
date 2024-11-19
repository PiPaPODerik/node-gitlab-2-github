const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const envFile = path.resolve('.env');
const nodeArgs = fs.existsSync(envFile) ? `--env-file=${envFile}` : '';
const tsNodeRegister = '-r ts-node/register';

const script = process.argv[2];
const command = `node ${nodeArgs} ${tsNodeRegister} ${script}`;

execSync(command, { stdio: 'inherit' });