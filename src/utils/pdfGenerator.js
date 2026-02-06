import PDFDocument from 'pdfkit';
import fs from 'fs';

export function generateTextPdf(title, subtitle, content, outputPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const stream = fs.createWriteStream(outputPath);

    doc.pipe(stream);

    doc.fontSize(20).text(title, { align: 'center' });
    doc.moveDown();
    doc.fontSize(14).text(subtitle, { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(content, { align: 'left' });

    doc.end();

    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
  });
}

export function generateFichaTecnica(data, outputPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const stream = fs.createWriteStream(outputPath);

    doc.pipe(stream);

    doc.fontSize(24).text('Ficha Técnica da Obra Musical', { align: 'center' });
    doc.moveDown();

    // 1. Identificação da Obra
    doc.fontSize(16).text('1. Identificação da Obra', { underline: true });
    doc.fontSize(12);
    doc.text(`Título: ${data.titulo}`);
    doc.text(`Estilo Musical: ${data.estilo}`);
    doc.text(`Tema: ${data.tema || 'Livre'}`);
    doc.text(`Idioma: Português`);
    doc.text(`Duração Aproximada: ${data.duracao || '--:--'}`);
    doc.text(`Data de Criação: ${new Date().toLocaleDateString('pt-BR')}`);
    doc.moveDown();

    // 2. Créditos Autorais
    doc.fontSize(16).text('2. Créditos Autorais', { underline: true });
    doc.fontSize(12);
    
    const autorInfo = data.nomeUsuario 
      ? `${data.nomeUsuario} - ${data.emailUsuario || ''}`
      : 'Usuário da Plataforma';

    doc.text(`Autor da Letra: ${autorInfo}`);
    doc.text(`Compositor: ${autorInfo}`);
    doc.text('Arranjo: Gerado com auxílio de Inteligência Artificial');
    doc.text('Plataforma de Criação: Cante e Ganhe');
    doc.moveDown();

    // 3. Descrição da Obra
    doc.fontSize(16).text('3. Descrição da Obra', { underline: true });
    doc.fontSize(12);
    doc.text(
      'A presente obra musical foi criada a partir de comandos fornecidos pelo usuário, com o auxílio de ferramentas de inteligência artificial, respeitando parâmetros criativos definidos como estilo musical, temática e emoção desejada.',
      { align: 'justify' }
    );
    doc.moveDown();

    // 4. Processo de Criação
    doc.fontSize(16).text('4. Processo de Criação', { underline: true });
    doc.fontSize(12);
    doc.text(
      'A música foi desenvolvida por meio de um sistema computacional de apoio à criação artística, no qual o usuário atuou como agente criativo principal, definindo os elementos conceituais e estruturais da obra. Os materiais gerados incluem letra, estrutura musical, partitura, cifra harmônica e gravação em áudio digital.',
      { align: 'justify' }
    );
    doc.moveDown();

    // 5. Declaração de Autoria
    doc.fontSize(16).text('5. Declaração de Autoria', { underline: true });
    doc.fontSize(12);
    doc.text(
      'O usuário declara ser o autor e titular dos direitos patrimoniais da obra musical descrita neste documento, assumindo total responsabilidade por seu uso, divulgação e eventual exploração comercial.',
      { align: 'justify' }
    );
    doc.moveDown();

    // 6. Aviso Legal
    doc.fontSize(16).text('6. Aviso Legal', { underline: true });
    doc.fontSize(12);
    doc.text(
      'Esta ficha técnica constitui documentação técnica de apoio à comprovação de autoria, não substituindo registros oficiais junto a órgãos públicos ou entidades de gestão coletiva. A plataforma limita-se a fornecer ferramentas tecnológicas de apoio à criação musical, não realizando validação jurídica, artística ou comercial da obra.',
      { align: 'justify' }
    );
    doc.moveDown();

    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown();
    doc.fontSize(10).fillColor('grey').text(`Documento gerado digitalmente em ${new Date().toLocaleDateString('pt-BR')}`, { align: 'left' });
    doc.text('Plataforma: Cante e Ganhe', { align: 'left' });

    doc.end();

    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
  });
}
