import archiver from "archiver";
import fs from "fs";

export async function exportKit(files, outputPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => {
      resolve();
    });

    archive.on("error", (err) => {
      reject(err);
    });

    archive.pipe(output);

    files.forEach(file => {
      // file object structure: { path: '/path/to/file', name: 'filename.pdf' }
      archive.file(file.path, { name: file.name });
    });

    archive.finalize();
  });
}
