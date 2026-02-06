export function parseMusic(content) {
  // Normaliza quebras de linha
  const normalized = content.replace(/\r\n/g, '\n');

  // Helper para extrair conteúdo entre marcadores
  function extractSection(text, startMarker, endMarkers) {
    const startIndex = text.indexOf(startMarker);
    if (startIndex === -1) return '';

    // Começa a buscar o fim após o início
    let endIndex = text.length;
    
    // Procura o marcador de fim mais próximo (o primeiro que aparecer)
    for (const marker of endMarkers) {
      const idx = text.indexOf(marker, startIndex + startMarker.length);
      if (idx !== -1 && idx < endIndex) {
        endIndex = idx;
      }
    }

    // Extrai o conteúdo
    let sectionContent = text.substring(startIndex + startMarker.length, endIndex);
    
    // Limpa separadores e espaços
    sectionContent = sectionContent.replace(/========================/g, '').trim();
    return sectionContent;
  }

  const letra = extractSection(normalized, '1. LETRA', ['2. CIFRA', '3. PARTITURA', '4. TITULO']);
  const cifra = extractSection(normalized, '2. CIFRA', ['3. PARTITURA', '4. TITULO']);
  let musicXML = extractSection(normalized, '3. PARTITURA', ['4. TITULO']);
  let titulo = extractSection(normalized, '4. TITULO', []);

  // Fallback: se falhar totalmente (nenhum header encontrado)
  if (!letra && !cifra && !musicXML && !titulo) {
      // Se não encontrou headers, retorna limpo de markdown mas assume que é tudo letra
      return { 
        letra: content.replace(/```/g, '').replace(/========================/g, '').trim(), 
        cifra: '', 
        musicXML: '', 
        titulo: '' 
      };
  }

  // Limpeza final extra
  if (musicXML) {
    musicXML = musicXML.replace(/```xml/g, '').replace(/```/g, '').trim();
  }
  if (titulo) {
    titulo = titulo.replace(/["']/g, '').trim(); // Remove aspas extras
  }

  return { letra, cifra, musicXML, titulo };
}
