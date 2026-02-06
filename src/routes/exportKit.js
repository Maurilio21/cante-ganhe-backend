import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { generateTextPdf, generateFichaTecnica } from '../utils/pdfGenerator.js';
import { xmlToPdf } from '../utils/scoreConverter.js';
import { exportKit } from '../services/exportService.js';
import { generateScoreFromLyrics, generateCipherFromLyrics } from '../services/llmService.js';

const router = express.Router();

router.post('/export-kit', async (req, res) => {
  // Create unique temp directory
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-'));

  try {
    const { 
      letra, 
      cifra, 
      musicXML, 
      titulo, 
      estilo, 
      tema, 
      duracao,
      audioUrl,
      nomeUsuario,
      emailUsuario
    } = req.body;

    const safeTitle = (titulo || 'musica').replace(/[^a-z0-9]/gi, '_');
    const filesToZip = [];

    // 1. Generate Letra PDF
    if (letra) {
      const letraPath = path.join(tempDir, 'Letra.pdf');
      await generateTextPdf(titulo || 'Música', 'Letra da Música', letra, letraPath);
      filesToZip.push({ path: letraPath, name: 'Letra.pdf' });
    }

    // 1.5 Check if Cifra is missing and generate it automatically
    let finalCifra = cifra;
    if (!finalCifra && letra) {
        console.log('Cifra not provided. Generating automatically via LLM...');
        try {
            finalCifra = await generateCipherFromLyrics({
                titulo,
                estilo,
                letra
            });
            console.log('Cifra generated successfully.');
        } catch (e) {
            console.error('Falha ao gerar Cifra automática:', e);
        }
    }

    // 2. Generate Cifra PDF
    if (finalCifra) {
      const cifraPath = path.join(tempDir, 'Cifra.pdf');
      await generateTextPdf(titulo || 'Música', 'Cifra Harmônica', finalCifra, cifraPath);
      filesToZip.push({ path: cifraPath, name: 'Cifra.pdf' });
    }

    // 3. Generate Partitura PDF (from MusicXML)
    let finalMusicXML = musicXML;
    
    console.log('Step 3: Checking MusicXML...');
    if (!finalMusicXML && (letra || finalCifra)) {
        console.log('MusicXML not provided. Generating automatically via LLM...');
        try {
            finalMusicXML = await generateScoreFromLyrics({
                titulo,
                estilo,
                letra,
                cifra: finalCifra
            });
            console.log('MusicXML generated successfully.');
        } catch (e) {
            console.error('Falha ao gerar MusicXML automático:', e);
        }
    } else {
        console.log('MusicXML provided by client.');
    }

    if (finalMusicXML) {
      const xmlPath = path.join(tempDir, 'score.musicxml');
      fs.writeFileSync(xmlPath, finalMusicXML);
      
      const partituraPath = path.join(tempDir, 'Partitura.pdf');
      console.log('Converting MusicXML to PDF...');
      try {
        await xmlToPdf(xmlPath, partituraPath);
        console.log('PDF conversion successful.');
        filesToZip.push({ path: partituraPath, name: 'Partitura.pdf' });
      } catch (err) {
        console.warn('Skipping Partitura PDF due to conversion error:', err.message);
        // Fallback: include the XML itself if PDF conversion fails
        filesToZip.push({ path: xmlPath, name: 'Partitura.musicxml' });
      }
    } else {
        console.log('No MusicXML available to convert.');
    }

    // 4. Generate Ficha Técnica PDF
    const fichaPath = path.join(tempDir, 'Ficha_Tecnica.pdf');
    await generateFichaTecnica({
        titulo: titulo || 'Música',
        estilo,
        tema,
        duracao,
        nomeUsuario,
        emailUsuario
    }, fichaPath);
    filesToZip.push({ path: fichaPath, name: 'Ficha_Tecnica.pdf' });

    // 5. Audio (Optional download)
    if (audioUrl) {
      try {
        const audioPath = path.join(tempDir, 'Audio.mp3');
        const response = await fetch(audioUrl);
        if (response.ok) {
            const buffer = await response.arrayBuffer();
            fs.writeFileSync(audioPath, Buffer.from(buffer));
            filesToZip.push({ path: audioPath, name: 'Audio.mp3' });
        }
      } catch (e) {
        console.warn('Failed to download audio:', e.message);
      }
    }

    // 6. Create ZIP
    const zipPath = path.join(tempDir, `Kit_Registro_${safeTitle}.zip`);
    await exportKit(filesToZip, zipPath);

    // 7. Send ZIP
    res.download(zipPath, `Kit_Registro_${safeTitle}.zip`, (err) => {
      if (err) {
        console.error('Error sending file:', err);
      }
      // Cleanup temp dir after download finishes (or fails)
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (e) {
        console.error('Cleanup error:', e);
      }
    });

  } catch (error) {
    console.error('Export Kit Error:', error);
    // Cleanup on error
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {}
    
    res.status(500).json({ error: 'Failed to generate kit' });
  }
});

export default router;
