import OpenAI from "openai";
import dotenv from 'dotenv';
import { parseMusic } from "./musicParser.js";

dotenv.config();

const client = new OpenAI({
  apiKey: process.env.OPENAI_KEY || process.env.OPENAI_API_KEY,
});

export async function applyAntifraud(musicData) {
  const prompt = `Você é um editor musical sênior. Sua tarefa é verificar a obra abaixo.

Seu objetivo é:
- Garantir que a letra não seja um plágio de músicas famosas existentes.
- Manter a qualidade artística.

CRITÉRIO DE PRESERVAÇÃO:
- Se a letra contiver nomes de empresas, marcas, nomes de pessoas ou slogans específicos, MANTENHA-OS. NÃO OS ALTERE.
- O usuário pode estar criando um Jingle ou música personalizada. Respeite os nomes próprios e frases específicas do texto original.
- Apenas reescreva trechos que sejam plágios óbvios de canções protegidas por direitos autorais ou que sejam de qualidade muito baixa (sem rima/ritmo).

Aqui está a obra gerada:
LETRA:
${musicData.letra}

TITULO:
${musicData.titulo || ''}

AÇÃO:
Se a obra já estiver boa e respeitar os critérios acima, apenas repita o conteúdo original.
PRESERVE todos os marcadores de seção na letra, como [Intro], [Verso 1], [Refrão], etc.

IMPORTANTE: Retorne APENAS o conteúdo final no formato padrão abaixo, SEM NENHUM COMENTÁRIO ADICIONAL:

========================
1. LETRA
========================
[Conteúdo]

========================
4. TITULO
========================
[Conteúdo]`;

  const response = await client.chat.completions.create({
    model: "gpt-4-turbo-preview",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3
  });

  const content = response.choices[0].message.content;
  return parseMusic(content);
}
