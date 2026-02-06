import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

function findMuseScorePath() {
  if (os.platform() !== 'win32') {
    return 'musescore'; // Default for Linux/Mac
  }

  // Windows: Check common paths
  const commonPaths = [
    'C:\\Program Files\\MuseScore 4\\bin\\MuseScore4.exe',
    'C:\\Program Files\\MuseScore 3\\bin\\MuseScore3.exe',
    'C:\\Program Files (x86)\\MuseScore 3\\bin\\MuseScore3.exe',
    process.env.MUSESCORE_PATH // Allow env var override
  ];

  for (const p of commonPaths) {
    if (p && fs.existsSync(p)) {
      return `"${p}"`;
    }
  }

  // Fallback to trying 'musescore' in PATH
  return 'musescore';
}

export function xmlToPdf(xmlPath, pdfOutput) {
  return new Promise((resolve, reject) => {
    const musescoreCmd = findMuseScorePath();
    const cmd = `${musescoreCmd} "${xmlPath}" -o "${pdfOutput}"`;

    console.log(`Executing: ${cmd}`);

    const timeout = setTimeout(() => {
      console.error('MuseScore conversion timed out');
      // No easy way to kill the specific child process from exec without saving the instance, 
      // but exec returns a ChildProcess.
    }, 45000); // 45s timeout

    const child = exec(cmd, { timeout: 45000 }, (error, stdout, stderr) => {
      clearTimeout(timeout);
      if (error) {
        console.error('MuseScore conversion failed or timed out:', error.message);
        console.error('Stderr:', stderr);
        reject(error);
      } else {
        console.log('MuseScore conversion success');
        resolve(pdfOutput);
      }
    });
  });
}
