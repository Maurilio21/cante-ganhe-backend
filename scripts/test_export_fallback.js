
import { exportKit } from "../src/routes/exportKit.js"; // We need to import the router logic or simulate the request
import request from "supertest";
import express from "express";
import exportKitRouter from "../src/routes/exportKit.js";
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env
dotenv.config({ path: path.join(__dirname, '../.env') });

const app = express();
app.use(express.json());
app.use("/", exportKitRouter);

async function testExportFallback() {
    console.log("Testing Export Kit Fallback Generation...");
    
    const outputDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir);
    }

    const data = {
        titulo: "Música de Teste Infantil",
        estilo: "Infantil - Festa Animada",
        tema: "Alegria e Brincadeiras",
        duracao: "2:00",
        audioUrl: "http://example.com/audio.mp3", // Fake URL
        letra: "[Verso 1]\nBrincando de roda\nPulando sem parar\n[Refrão]\nÉ festa, é festa\nVamos celebrar"
        // Note: Cifra and MusicXML are MISSING
    };

    try {
        const response = await request(app)
            .post("/export-kit")
            .send(data)
            .responseType('blob'); // Expect binary response

        if (response.status === 200) {
            console.log("SUCCESS: Export request succeeded.");
            const outputPath = path.join(outputDir, 'kit_teste_fallback.zip');
            fs.writeFileSync(outputPath, response.body);
            console.log(`ZIP file saved to: ${outputPath}`);
            console.log("Check the ZIP file to ensure Cifra and Partitura PDFs are present.");
        } else {
            console.error("FAILURE: Export request failed with status", response.status);
            console.error("Response:", response.text);
        }

    } catch (error) {
        console.error("Error during export test:", error);
    }
}

testExportFallback();
