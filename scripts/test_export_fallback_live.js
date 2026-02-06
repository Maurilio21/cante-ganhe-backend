
import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function testExportFallback() {
    console.log("Testing Export Kit Fallback Generation (Live Server)...");
    
    const outputDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir);
    }

    const data = {
        titulo: "Música de Teste Infantil",
        estilo: "Infantil - Festa Animada",
        tema: "Alegria e Brincadeiras",
        duracao: "2:00",
        audioUrl: "http://example.com/audio.mp3",
        letra: "[Verso 1]\nBrincando de roda\nPulando sem parar\n[Refrão]\nÉ festa, é festa\nVamos celebrar"
        // Cifra and MusicXML are MISSING
    };

    try {
        const response = await axios.post("http://localhost:3000/api/export-kit", data, {
            responseType: 'arraybuffer'
        });

        if (response.status === 200) {
            console.log("SUCCESS: Export request succeeded.");
            const outputPath = path.join(outputDir, 'kit_teste_fallback_live.zip');
            fs.writeFileSync(outputPath, response.data);
            console.log(`ZIP file saved to: ${outputPath}`);
            console.log("Check the ZIP file to ensure Cifra and Partitura PDFs are present.");
        } else {
            console.error("FAILURE: Export request failed with status", response.status);
        }

    } catch (error) {
        console.error("Error during export test:", error.message);
        if (error.response) {
            console.error("Response data:", error.response.data.toString());
        }
    }
}

testExportFallback();
