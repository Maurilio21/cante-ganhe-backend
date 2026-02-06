
import { generateWithLLM } from "../src/services/llmService.js";
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env from backend root
dotenv.config({ path: path.join(__dirname, '../.env') });

async function testInfantilStyle() {
    console.log("Testing Infantil Style Generation...");
    
    const style = 'Infantil - Festa Animada';
    const data = {
        estilo: style,
        emocao: 'Alegre e Divertida',
        tema: 'Aniversário na Escola',
        duracao: '2:00',
        publico: 'Crianças'
    };

    try {
        const result = await generateWithLLM(data);
        console.log("Generation Result:");
        console.log("Titulo:", result.titulo);
        console.log("Letra Preview:", result.letra ? result.letra.substring(0, 100) + "..." : "No Lyrics");
        
        if (result.titulo && result.letra) {
            console.log("SUCCESS: Lyrics and Title generated for style:", style);
        } else {
            console.error("FAILURE: Missing Title or Lyrics");
        }

        if (result.cifra || result.musicXML) {
            console.warn("WARNING: Cifra or MusicXML should NOT be generated at this stage.");
        } else {
            console.log("SUCCESS: Cifra and MusicXML correctly omitted.");
        }

    } catch (error) {
        console.error("Error during generation:", error);
    }
}

testInfantilStyle();
