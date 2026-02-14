import express from "express";
import axios from "axios";
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

    const openAiKey = process.env.OPENAI_KEY || process.env.OPENAI_API_KEY;
    if (!openAiKey || !openAiKey.trim()) {
      return res.status(503).json({
        success: false,
        error: "OPENAI_KEY/OPENAI_API_KEY ausente. Configure no .env do backend."
      });
    }

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
    res.status(500).json({
      success: false,
      error: err?.message || "Erro ao gerar música"
    });
  }
});

router.post("/vocal-removal/generate", async (req, res) => {
  try {
    const pool = req.app?.locals?.pool;
    const memoryStore = req.app?.locals?.memoryStore;

    const { userId, trackId, sourceTaskId, audioId, mode, options } = req.body || {};
    if (!userId || !trackId || !sourceTaskId || !audioId) {
      return res.status(400).json({ success: false, error: "userId, trackId, sourceTaskId e audioId obrigatórios" });
    }
    const apiKey = process.env.KIE_API_KEY || process.env.GOAPI_KEY || process.env.X_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ success: false, error: "KIE_API_KEY ausente" });
    }
    const callbackUrl = process.env.KIE_VOCAL_CALLBACK_URL;
    // Callback URL is optional in local/memory mode, but required for prod
    if (!callbackUrl && pool) {
      return res.status(500).json({ success: false, error: "KIE_VOCAL_CALLBACK_URL ausente" });
    }
    
    const baseUrl = (process.env.KIE_BASE_URL || "https://api.kie.ai").replace(/\/$/, "");
    const generatePath = process.env.KIE_VOCAL_GENERATE_PATH || "/api/v1/vocal-removal/generate";
    const requestBody = {
      taskId: String(sourceTaskId),
      audioId: String(audioId),
      callBackUrl: callbackUrl || "http://localhost:3000/api/vocal-removal/callback" // Dummy for local
    };
    if (mode) {
      requestBody.type = mode; // Changed from mode to type based on API docs
    }
    if (options && typeof options === "object") {
      for (const [key, value] of Object.entries(options)) {
        if (value !== undefined) {
          requestBody[key] = value;
        }
      }
    }

    // Log for debugging
    console.log("Sending vocal removal request:", JSON.stringify(requestBody, null, 2));

    const response = await axios.post(`${baseUrl}${generatePath}`, requestBody, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      }
    });

    const responseData = response?.data ?? {};
    const responseTaskId =
      responseData?.data?.taskId ||
      responseData?.data?.task_id ||
      responseData?.taskId ||
      responseData?.task_id ||
      responseData?.id;

    if (!responseTaskId) {
      return res.status(502).json({ success: false, error: "Resposta inválida da API" });
    }

    const taskData = {
        task_id: String(responseTaskId),
        user_id: String(userId),
        track_id: String(trackId),
        source_task_id: String(sourceTaskId),
        audio_id: String(audioId),
        mode: mode ?? null,
        status: responseData?.data?.status ?? "submitted",
        result: responseData ?? {},
        created_at: new Date(),
        updated_at: new Date()
    };

    if (pool) {
      await pool.query(
        `insert into stem_tasks
          (task_id, user_id, track_id, source_task_id, audio_id, mode, status, result)
         values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         on conflict (task_id) do update set
          user_id = excluded.user_id,
          track_id = excluded.track_id,
          source_task_id = excluded.source_task_id,
          audio_id = excluded.audio_id,
          mode = excluded.mode,
          status = excluded.status,
          result = excluded.result,
          updated_at = now()`,
        [
          taskData.task_id,
          taskData.user_id,
          taskData.track_id,
          taskData.source_task_id,
          taskData.audio_id,
          taskData.mode,
          taskData.status,
          JSON.stringify(taskData.result)
        ]
      );
    } else if (memoryStore) {
        memoryStore.stem_tasks.set(taskData.task_id, taskData);
        if (memoryStore.save) memoryStore.save();
    }

    return res.json({ success: true, data: { taskId: responseTaskId } });
  } catch (error) {
    console.error("Vocal removal error:", error);
    const status = error?.response?.status || 500;
    const details = error?.response?.data || error?.message || "Erro desconhecido";
    return res.status(status).json({ success: false, error: String(JSON.stringify(details)) });
  }
});

router.post("/vocal-removal/callback", async (req, res) => {
  try {
    const pool = req.app?.locals?.pool;
    const memoryStore = req.app?.locals?.memoryStore;

    const payload = req.body || {};
    const data = payload?.data || payload;
    const taskId =
      data?.taskId ||
      data?.task_id ||
      payload?.taskId ||
      payload?.task_id ||
      payload?.id;
    const status = data?.status || payload?.status || "unknown";
    if (!taskId) {
      return res.json({ ok: true });
    }

    if (pool) {
      await pool.query(
        `insert into stem_tasks
          (task_id, status, result)
         values ($1,$2,$3::jsonb)
         on conflict (task_id) do update set
          status = excluded.status,
          result = excluded.result,
          updated_at = now()`,
        [String(taskId), String(status), JSON.stringify(payload ?? {})]
      );
    } else if (memoryStore) {
      const existing = memoryStore.stem_tasks.get(String(taskId));
      if (existing) {
        existing.status = String(status);
        existing.result = payload ?? {};
        existing.updated_at = new Date();
        memoryStore.stem_tasks.set(String(taskId), existing);
      } else {
        memoryStore.stem_tasks.set(String(taskId), {
          task_id: String(taskId),
          status: String(status),
          result: payload ?? {},
          updated_at: new Date()
        });
      }
      if (memoryStore.save) memoryStore.save();
    }

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false });
  }
});

router.get("/vocal-removal/status", async (req, res) => {
    console.log("DEBUG: GET /vocal-removal/status hit");
    try {
      const pool = req.app?.locals?.pool;
      const memoryStore = req.app?.locals?.memoryStore;
      console.log(`DEBUG: pool exists? ${!!pool}, memoryStore exists? ${!!memoryStore}`);

      const { taskId, userId, trackId } = req.query || {};
    if (!taskId && !(userId && trackId)) {
      return res.status(400).json({ success: false, error: "taskId ou userId/trackId obrigatórios" });
    }

    let result;
    if (pool) {
      if (taskId) {
        result = await pool.query(
          `select * from stem_tasks where task_id = $1 limit 1`,
          [String(taskId)]
        );
      } else {
        result = await pool.query(
          `select * from stem_tasks where user_id = $1 and track_id = $2 order by created_at desc limit 1`,
          [String(userId), String(trackId)]
        );
      }
    } else if (memoryStore) {
      if (taskId) {
        const task = memoryStore.stem_tasks.get(String(taskId));
        result = task ? { rows: [task] } : { rows: [] };
      } else {
        const tasks = Array.from(memoryStore.stem_tasks.values())
            .filter(t => t.user_id === String(userId) && t.track_id === String(trackId))
            .sort((a, b) => b.created_at - a.created_at);
        result = tasks.length ? { rows: [tasks[0]] } : { rows: [] };
      }
    }

    if (!result?.rows?.length) {
      return res.status(404).json({ success: false, error: "Nenhum resultado encontrado" });
    }

    let row = result.rows[0];

    // Active polling fallback for local/memory mode
    let internalStatus = row.status;

    // 1. Poll if needed (status is pending/processing)
    if ((!internalStatus || internalStatus === 'submitted' || internalStatus === 'processing') && !pool) {
      try {
        const apiKey = process.env.KIE_API_KEY || process.env.GOAPI_KEY || process.env.X_API_KEY;
        if (apiKey) {
            const baseUrl = (process.env.KIE_BASE_URL || "https://api.kie.ai").replace(/\/$/, "");
            const statusUrl = `${baseUrl}/api/v1/vocal-removal/record-info?taskId=${row.task_id}`;
            
            console.log(`Polling: ${statusUrl}`);
            
            let remoteStatus = null;
            try {
                const response = await axios.get(statusUrl, {
                    headers: { "Authorization": `Bearer ${apiKey}` },
                    validateStatus: () => true
                });
                
                if (response.status === 200) {
                    remoteStatus = response;
                } else {
                     console.log(`Poll failed with status ${response.status}:`, response.data);
                }
            } catch (e) {
                console.error(`Error polling ${statusUrl}:`, e.message);
            }

            if (remoteStatus && remoteStatus.data) {
                const responseBody = remoteStatus.data;
                const data = responseBody.data;
                
                if (responseBody.code === 200 && data) {
                    const status = data.successFlag || data.status;
                    
                    console.log(`Poll success. Status: ${status}`);
                    
                    let newStatus = internalStatus;
                    if (status === 'SUCCESS' || status === 'completed') newStatus = 'success';
                    else if (status === 'PENDING' || status === 'processing') newStatus = 'processing';
                    else if (status === 'CREATE_TASK_FAILED' || status === 'GENERATE_AUDIO_FAILED' || status === 'CALLBACK_EXCEPTION' || status === 'failed') newStatus = 'failed';

                    if (newStatus !== internalStatus) {
                        console.log(`Status updated: ${internalStatus} -> ${newStatus}`);
                        internalStatus = newStatus;
                        row.status = newStatus;
                        row.result = data;
                        row.updated_at = new Date();
                        
                        if (memoryStore) {
                            memoryStore.stem_tasks.set(row.task_id, row);
                            if (memoryStore.save) memoryStore.save();
                        }
                    }
                }
            }
        }
      } catch (pollError) {
        console.error("Active polling error:", pollError);
      }
    }

    // 2. Check for missing tracks (only if success)
    let shouldCreateTracks = false;
    if (internalStatus === 'success') {
        let tracksExist = false;
        if (pool) {
             const existing = await pool.query('select 1 from user_tracks where source_task_id = $1 limit 1', [row.task_id]);
             tracksExist = (existing.rowCount > 0);
        } else if (memoryStore) {
             const tracks = Array.from(memoryStore.user_tracks.values());
             tracksExist = tracks.some(t => t.source_task_id === row.task_id);
             console.log(`DEBUG: Checking tracks for task ${row.task_id}. Total tracks: ${tracks.length}. Found match? ${tracksExist}`);
        }
        
        if (!tracksExist) {
            console.log(`Task ${row.task_id} is success but no tracks found. Triggering creation.`);
            shouldCreateTracks = true;
        }
    }

    // 3. Create tracks if needed
    if (shouldCreateTracks && (memoryStore || pool)) {
        console.log("Creating tracks from separation result...");
        
        const data = row.result;
        if (data) {
            const resultData = data.response || data;
            const stems = [];
            
            if (resultData.vocalUrl) stems.push({ name: 'Voz', url: resultData.vocalUrl, style_suffix: ' - Voz' });
            if (resultData.instrumentalUrl) stems.push({ name: 'Instrumental', url: resultData.instrumentalUrl, style_suffix: ' - Instrumental' });
            if (resultData.drumsUrl) stems.push({ name: 'Bateria', url: resultData.drumsUrl, style_suffix: ' - Bateria' });
            if (resultData.bassUrl) stems.push({ name: 'Baixo', url: resultData.bassUrl, style_suffix: ' - Baixo' });
            if (resultData.guitarUrl) stems.push({ name: 'Guitarra', url: resultData.guitarUrl, style_suffix: ' - Guitarra' });
            if (resultData.pianoUrl) stems.push({ name: 'Piano', url: resultData.pianoUrl, style_suffix: ' - Piano' });
            if (resultData.otherUrl) stems.push({ name: 'Outros', url: resultData.otherUrl, style_suffix: ' - Outros' });
            if (resultData.backingVocalsUrl) stems.push({ name: 'Backing Vocals', url: resultData.backingVocalsUrl, style_suffix: ' - Backing Vocals' });

            console.log(`Found ${stems.length} stems to create tracks for.`);
            
            for (const stem of stems) {
                const randomSuffix = Math.random().toString(36).substring(7);
                const stemTrack = {
                    id: createHash(stem.url + Date.now() + randomSuffix),
                    sourceTaskId: row.task_id,
                    title: `${row.title || 'Música'} (${stem.name})`,
                    style: (row.style || '') + stem.style_suffix,
                    coverColorHex: row.cover_color_hex,
                    imageUrl: row.image_url,
                    audioUrl: stem.url,
                    createdAt: new Date(),
                    duration: row.duration,
                    mode: row.mode,
                    prompt: `Separated ${stem.name} from ${row.title}`,
                    isStem: true
                };
                
                console.log(`Creating stem track: ${stemTrack.title} (${stemTrack.id})`);

                if (pool) {
                    try {
                        await pool.query(
                            `insert into user_tracks
                            (user_id, track_id, source_task_id, title, style, cover_color_hex, image_url, audio_url, created_at, duration, prompt, mode)
                            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                            on conflict (user_id, track_id) do nothing`,
                            [
                                row.user_id, stemTrack.id, stemTrack.sourceTaskId, stemTrack.title, stemTrack.style, stemTrack.coverColorHex,
                                stemTrack.imageUrl, stemTrack.audioUrl, stemTrack.createdAt, stemTrack.duration, stemTrack.prompt, stemTrack.mode
                            ]
                        );
                    } catch (dbErr) {
                        console.error("Error inserting stem track into DB:", dbErr);
                    }
                } else if (memoryStore) {
                     const newTrack = {
                         track_id: stemTrack.id,
                         user_id: row.user_id,
                         source_task_id: stemTrack.sourceTaskId,
                         title: stemTrack.title,
                         style: stemTrack.style,
                         cover_color_hex: stemTrack.coverColorHex,
                         image_url: stemTrack.imageUrl,
                         audio_url: stemTrack.audioUrl,
                         created_at: stemTrack.createdAt,
                         duration: stemTrack.duration,
                         prompt: stemTrack.prompt,
                         mode: stemTrack.mode,
                         updated_at: new Date()
                     };
                     
                     if (memoryStore.user_tracks instanceof Map) {
                          memoryStore.user_tracks.set(stemTrack.id, newTrack);
                     } else {
                          // Handle array/map mismatch fallback
                          if (Array.isArray(memoryStore.user_tracks)) {
                               const map = new Map();
                               memoryStore.user_tracks.forEach(t => map.set(t.track_id, t));
                               memoryStore.user_tracks = map;
                          }
                          if (memoryStore.user_tracks instanceof Map) {
                              memoryStore.user_tracks.set(stemTrack.id, newTrack);
                          }
                     }
                }
            }
            
            if (memoryStore && memoryStore.save) memoryStore.save();
        }
    }

    return res.json({
      success: true,
      data: {
        taskId: row.task_id,
        userId: row.user_id,
        trackId: row.track_id,
        sourceTaskId: row.source_task_id,
        audioId: row.audio_id,
        mode: row.mode,
        status: row.status,
        result: row.result
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Falha ao buscar status" });
  }
});

const mapRowToTrack = (row) => ({
  id: row.track_id,
  sourceTaskId: row.source_task_id,
  title: row.title,
  style: row.style,
  coverColorHex: row.cover_color_hex,
  imageUrl: row.image_url,
  audioUrl: row.audio_url,
  createdAt: row.created_at,
  lyrics: row.lyrics,
  duration: row.duration,
  prompt: row.prompt,
  mode: row.mode,
  voice: row.voice,
  cifra: row.cifra,
  musicXML: row.music_xml
});

router.get("/tracks", async (req, res) => {
  try {
    const pool = req.app?.locals?.pool;
    const memoryStore = req.app?.locals?.memoryStore;
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ success: false, error: "userId obrigatório" });
    }

    if (pool) {
      const result = await pool.query(
        `select * from user_tracks where user_id = $1 order by created_at desc nulls last`,
        [String(userId)]
      );
      const tracks = result.rows.map(mapRowToTrack);
      return res.json({ success: true, data: tracks });
    } else if (memoryStore) {
       // Fallback for memory store
       const tracks = Array.from(memoryStore.user_tracks.values())
           .filter(t => t.user_id === String(userId))
           .sort((a, b) => {
               const dateA = new Date(a.created_at || 0);
               const dateB = new Date(b.created_at || 0);
               return dateB - dateA;
           })
           .map(mapRowToTrack);
       return res.json({ success: true, data: tracks });
    } else {
       return res.status(503).json({ success: false, error: "Database indisponível" });
    }
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: "Falha ao buscar músicas" });
  }
});

router.post("/tracks", async (req, res) => {
  try {
    const pool = req.app?.locals?.pool;
    const memoryStore = req.app?.locals?.memoryStore;
    const { userId, track } = req.body || {};
    
    if (!userId || !track || !track.id) {
      return res.status(400).json({ success: false, error: "userId e track obrigatórios" });
    }

    const payload = {
      userId: String(userId),
      trackId: String(track.id),
      sourceTaskId: track.sourceTaskId ?? null,
      title: track.title ?? null,
      style: track.style ?? null,
      coverColorHex: track.coverColorHex ?? null,
      imageUrl: track.imageUrl ?? null,
      audioUrl: track.audioUrl ?? null,
      createdAt: track.createdAt ? new Date(track.createdAt) : null,
      lyrics: track.lyrics ?? null,
      duration: track.duration ?? null,
      prompt: track.prompt ?? null,
      mode: track.mode ?? null,
      voice: track.voice ?? null,
      cifra: track.cifra ?? null,
      musicXML: track.musicXML ?? null
    };

    if (pool) {
      await pool.query(
        `insert into user_tracks
          (user_id, track_id, source_task_id, title, style, cover_color_hex, image_url, audio_url, created_at, lyrics, duration, prompt, mode, voice, cifra, music_xml, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
         on conflict (user_id, track_id) do update set
          source_task_id = excluded.source_task_id,
          title = excluded.title,
          style = excluded.style,
          cover_color_hex = excluded.cover_color_hex,
          image_url = excluded.image_url,
          audio_url = excluded.audio_url,
          created_at = excluded.created_at,
          lyrics = excluded.lyrics,
          duration = excluded.duration,
          prompt = excluded.prompt,
          mode = excluded.mode,
          voice = excluded.voice,
          cifra = excluded.cifra,
          music_xml = excluded.music_xml,
          updated_at = now()`,
        [
          payload.userId,
          payload.trackId,
          payload.sourceTaskId,
          payload.title,
          payload.style,
          payload.coverColorHex,
          payload.imageUrl,
          payload.audioUrl,
          payload.createdAt,
          payload.lyrics,
          payload.duration,
          payload.prompt,
          payload.mode,
          payload.voice,
          payload.cifra,
          payload.musicXML
        ]
      );
    } else if (memoryStore) {
        const newTrack = {
             track_id: payload.trackId,
             user_id: payload.userId,
             source_task_id: payload.sourceTaskId,
             title: payload.title,
             style: payload.style,
             cover_color_hex: payload.coverColorHex,
             image_url: payload.imageUrl,
             audio_url: payload.audioUrl,
             created_at: payload.createdAt,
             lyrics: payload.lyrics,
             duration: payload.duration,
             prompt: payload.prompt,
             mode: payload.mode,
             voice: payload.voice,
             cifra: payload.cifra,
             music_xml: payload.musicXML,
             updated_at: new Date()
        };
        memoryStore.user_tracks.set(payload.trackId, newTrack);
        if (memoryStore.save) memoryStore.save();
    } else {
       return res.status(503).json({ success: false, error: "Database indisponível" });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: "Falha ao salvar música" });
  }
});

router.post("/tracks/bulk", async (req, res) => {
  try {
    const pool = req.app?.locals?.pool;
    const memoryStore = req.app?.locals?.memoryStore;
    const { userId, tracks } = req.body || {};
    
    if (!userId || !Array.isArray(tracks)) {
      return res.status(400).json({ success: false, error: "userId e tracks obrigatórios" });
    }

    if (pool) {
      for (const track of tracks) {
        if (!track || !track.id) {
          continue;
        }
        await pool.query(
          `insert into user_tracks
            (user_id, track_id, source_task_id, title, style, cover_color_hex, image_url, audio_url, created_at, lyrics, duration, prompt, mode, voice, cifra, music_xml, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
           on conflict (user_id, track_id) do update set
            source_task_id = excluded.source_task_id,
            title = excluded.title,
            style = excluded.style,
            cover_color_hex = excluded.cover_color_hex,
            image_url = excluded.image_url,
            audio_url = excluded.audio_url,
            created_at = excluded.created_at,
            lyrics = excluded.lyrics,
            duration = excluded.duration,
            prompt = excluded.prompt,
            mode = excluded.mode,
            voice = excluded.voice,
            cifra = excluded.cifra,
            music_xml = excluded.music_xml,
            updated_at = now()`,
          [
            String(userId),
            String(track.id),
            track.sourceTaskId ?? null,
            track.title ?? null,
            track.style ?? null,
            track.coverColorHex ?? null,
            track.imageUrl ?? null,
            track.audioUrl ?? null,
            track.createdAt ? new Date(track.createdAt) : null,
            track.lyrics ?? null,
            track.duration ?? null,
            track.prompt ?? null,
            track.mode ?? null,
            track.voice ?? null,
            track.cifra ?? null,
            track.musicXML ?? null
          ]
        );
      }
    } else if (memoryStore) {
        for (const track of tracks) {
            if (!track || !track.id) continue;
            
            const newTrack = {
                track_id: String(track.id),
                user_id: String(userId),
                source_task_id: track.sourceTaskId ?? null,
                title: track.title ?? null,
                style: track.style ?? null,
                cover_color_hex: track.coverColorHex ?? null,
                image_url: track.imageUrl ?? null,
                audio_url: track.audioUrl ?? null,
                created_at: track.createdAt ? new Date(track.createdAt) : null,
                lyrics: track.lyrics ?? null,
                duration: track.duration ?? null,
                prompt: track.prompt ?? null,
                mode: track.mode ?? null,
                voice: track.voice ?? null,
                cifra: track.cifra ?? null,
                music_xml: track.musicXML ?? null,
                updated_at: new Date()
            };
            memoryStore.user_tracks.set(newTrack.track_id, newTrack);
        }
        if (memoryStore.save) memoryStore.save();
    } else {
        return res.status(503).json({ success: false, error: "Database indisponível" });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: "Falha ao salvar músicas" });
  }
});

router.put("/tracks/:id", async (req, res) => {
  try {
    const pool = req.app?.locals?.pool;
    const memoryStore = req.app?.locals?.memoryStore;
    const { userId, title } = req.body || {};
    const { id } = req.params;
    
    if (!userId || !id || title === undefined) {
      return res.status(400).json({ success: false, error: "userId e title obrigatórios" });
    }

    if (pool) {
      await pool.query(
        `update user_tracks set title = $1, updated_at = now() where user_id = $2 and track_id = $3`,
        [String(title), String(userId), String(id)]
      );
    } else if (memoryStore) {
        const track = memoryStore.user_tracks.get(String(id));
        if (track && track.user_id === String(userId)) {
            track.title = String(title);
            track.updated_at = new Date();
            memoryStore.user_tracks.set(String(id), track);
            if (memoryStore.save) memoryStore.save();
        }
    } else {
        return res.status(503).json({ success: false, error: "Database indisponível" });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: "Falha ao atualizar música" });
  }
});

router.delete("/tracks/:id", async (req, res) => {
  try {
    const pool = req.app?.locals?.pool;
    const memoryStore = req.app?.locals?.memoryStore;
    const { userId } = req.query;
    const { id } = req.params;
    
    if (!userId || !id) {
      return res.status(400).json({ success: false, error: "userId obrigatório" });
    }

    if (pool) {
      await pool.query(
        `delete from user_tracks where user_id = $1 and track_id = $2`,
        [String(userId), String(id)]
      );
    } else if (memoryStore) {
        const track = memoryStore.user_tracks.get(String(id));
        if (track && track.user_id === String(userId)) {
            memoryStore.user_tracks.delete(String(id));
            if (memoryStore.save) memoryStore.save();
        }
    } else {
        return res.status(503).json({ success: false, error: "Database indisponível" });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: "Falha ao remover música" });
  }
});

export default router;
