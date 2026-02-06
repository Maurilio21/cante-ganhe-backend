import OpenAI from "openai";
import dotenv from 'dotenv';
import { parseMusic } from "./musicParser.js";

dotenv.config();

const client = new OpenAI({ apiKey: process.env.OPENAI_KEY });

export async function generateWithLLM(data) {
  const prompt = buildPrompt(data);

  const response = await client.chat.completions.create({
    model: "gpt-4-turbo-preview",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.85
  });

  return parseMusic(response.choices[0].message.content);
}

export async function generateScoreFromLyrics(data) {
  const prompt = `Você é um copista musical profissional.

Crie uma partitura em MusicXML com as seguintes regras obrigatórias:

- Melodia MONOFÔNICA (uma nota por vez)
- Compassos simples (4/4 ou 3/4)
- Andamento médio
- Notas entre C4 e D5
- Estrutura simples (verso e refrão)
- Sem acordes complexos, sem polifonia
- Inclua a LETRA alinhada à melodia (lyric tags)
- Partitura clara, legível e adequada para registro musical

Parâmetros:
- Estilo: ${data.estilo || 'Pop'}
- Título: ${data.titulo || 'Música'}

Conteúdo base (para ritmo e prosódia):
${data.letra}

Retorne APENAS o código MusicXML válido (MusicXML 3.1).`;

  const response = await client.chat.completions.create({
    model: "gpt-4-turbo-preview",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2
  });

  let content = response.choices[0].message.content;
  // Remove markdown code blocks if present
  content = content.replace(/```xml/g, '').replace(/```/g, '').trim();
  return content;
}

export async function generateCipherFromLyrics(data) {
  const prompt = `Você é um músico expert.
Crie uma CIFRA completa para a seguinte letra/música.

ESTILO: ${data.estilo || 'Pop'}
TÍTULO: ${data.titulo || 'Música'}

LETRA:
${data.letra}

INSTRUÇÕES:
- Adicione os acordes (cifras) sobre as linhas da letra.
- Use notação padrão (C, D, Em, G7, etc.).
- Mantenha a estrutura da letra (Verso, Refrão).
- Retorne APENAS a letra com as cifras, sem comentários.`;

  const response = await client.chat.completions.create({
    model: "gpt-4-turbo-preview",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.5
  });

  return response.choices[0].message.content;
}

function buildPrompt(data) {
  const estilo = data.estilo || '';
  const estiloLower = estilo.toLowerCase();
  const restrictedStyleKeywords = [
    'heavy metal',
    'rock',
    'trap',
    'funk',
    'rap',
    'hip hop',
  ];
  const isRestrictedStyle = restrictedStyleKeywords.some((keyword) =>
    estiloLower.includes(keyword),
  );
  const heavyMetalRule = isRestrictedStyle
    ? `
REGRAS ESPECIAIS PARA ESTE ESTILO:
- É PROIBIDO qualquer tema relacionado a ocultismo, palavrões, violência, conteúdo assustador, invocações ou adorações a espíritos malignos.
- A ÚNICA exceção permitida é letra que glorifique Jesus Cristo como o único digno de ser adorado, ou músicas de adoração ao Senhor Jesus.
`
    : '';
  return `Atue como um assistente de composição musical criativa. Sua tarefa é ajudar o usuário a visualizar uma ideia musical completa.

Gere um EXEMPLO DE COMPOSIÇÃO ORIGINAL baseado nos seguintes parâmetros:

DADOS DO PROJETO:
- Estilo: ${estilo}
- Emoção: ${data.emocao}
- Tema: ${data.tema}
- Idioma: Português (Brasil)

${heavyMetalRule}

INSTRUÇÕES:
1. Escreva uma letra criativa e envolvente sobre o tema (com formatação [Verso], [Refrão]).
2. Sugira um título curto.

IMPORTANTE: O conteúdo deve ser fictício e original, criado apenas para fins de demonstração e inspiração.
NÃO GERE CIFRAS OU PARTITURAS NESTA ETAPA. APENAS LETRA E TÍTULO.

FORMATO DE RESPOSTA OBRIGATÓRIO (Use exatamente estes separadores):

========================
1. LETRA
========================
[Letra completa com seções: Verso, Refrão, etc.]

========================
4. TITULO
========================
[Apenas o título]`;
}
