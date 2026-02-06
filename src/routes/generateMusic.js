import express from "express";
import { generateWithLLM } from "../services/llmService.js";
import { applyAntifraud } from "../services/antifraudService.js";
import { createHash } from "../utils/hash.js";
import { validateLyrics } from "../../scripts/lyrics_validator.js";

const router = express.Router();

router.post("/generate-music", async (req, res) => {
  try {
    const {
      userId,
      estilo,
      emocao,
      tema,
      duracao,
      publico,
      compasso
    } = req.body;

    // 1️⃣ Geração principal
    const rawMusic = await generateWithLLM({
      estilo,
      emocao,
      tema,
      duracao,
      publico
    });

    // 2️⃣ Antifraude / Antiplágio
    const safeMusic = await applyAntifraud(rawMusic);

    let validation = null;
    try {
      validation = await validateLyrics({
        title: safeMusic.titulo,
        lyrics: safeMusic.letra,
        genre: estilo,
        timeSignature: compasso || "4/4"
      });
    } catch (validationError) {
      console.error(validationError);
    }

    // 3️⃣ Hash técnico (prova de criação)
    const musicHash = createHash(safeMusic);

    // 4️⃣ Persistência (exemplo)
    // await db.music.create({ userId, ...safeMusic, musicHash })

    return res.json({
      success: true,
      data: {
        letra: safeMusic.letra,
        cifra: safeMusic.cifra,
        musicXML: safeMusic.musicXML,
        titulo: safeMusic.titulo,
        hash: musicHash,
        validation
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao gerar música" });
  }
});

export default router;
