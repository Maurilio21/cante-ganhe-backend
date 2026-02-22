import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import PDFDocument from 'pdfkit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const invoicesDir = path.resolve(__dirname, '../storage/invoices');

if (!fs.existsSync(invoicesDir)) {
  fs.mkdirSync(invoicesDir, { recursive: true });
}

export const generateInvoicePdf = async ({
  user,
  order,
  transaction,
  pixInfo,
}) => {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const chunks = [];

  doc.on('data', (chunk) => chunks.push(chunk));

  const issueDate = new Date();
  const invoiceId = transaction.id;

  doc.fontSize(14).text('NOTA FISCAL DE SERVIÇOS - SIMPLIFICADA', {
    align: 'center',
  });
  doc.moveDown(0.5);
  doc
    .fontSize(10)
    .text(`Número: ${invoiceId}`, { align: 'center' })
    .text(`Data de emissão: ${issueDate.toLocaleString('pt-BR')}`, {
      align: 'center',
    });

  doc.moveDown(1.5);
  doc.fontSize(11).text('Dados do Prestador', { underline: true });
  doc.moveDown(0.3);
  doc.text('Cante e Ganhe Plataforma Digital');
  doc.text('CNPJ: 41.357.540/0001-04');

  doc.moveDown(1);
  doc.text('Dados do Tomador', { underline: true });
  doc.moveDown(0.3);
  doc.text(`Nome: ${user?.name || 'Não informado'}`);
  if (pixInfo?.cpfCnpj) doc.text(`CPF/CNPJ: ${pixInfo.cpfCnpj}`);
  if (!pixInfo?.cpfCnpj && user?.cpf) doc.text(`CPF/CNPJ: ${user.cpf}`);
  if (user?.email) doc.text(`E-mail: ${user.email}`);
  if (user?.phone) doc.text(`Telefone: ${user.phone}`);
  const addressLineParts = [];
  if (user?.addressStreet) {
    addressLineParts.push(user.addressStreet);
  }
  if (user?.addressNumber) {
    addressLineParts.push(`, ${user.addressNumber}`);
  }
  if (user?.addressComplement) {
    addressLineParts.push(` - ${user.addressComplement}`);
  }
  if (addressLineParts.length > 0) {
    doc.text(`Endereço: ${addressLineParts.join('')}`);
  }
  const addressDetails = [];
  if (user?.addressDistrict) {
    addressDetails.push(user.addressDistrict);
  }
  const cityStateParts = [];
  if (user?.addressCity) {
    cityStateParts.push(user.addressCity);
  }
  if (user?.addressState) {
    cityStateParts.push(user.addressState);
  }
  if (cityStateParts.length > 0) {
    addressDetails.push(cityStateParts.join(' - '));
  }
  if (user?.addressZip) {
    addressDetails.push(`CEP: ${user.addressZip}`);
  }
  if (addressDetails.length > 0) {
    doc.text(addressDetails.join(' | '));
  }

  doc.moveDown(1);
  doc.text('Dados do Serviço', { underline: true });
  doc.moveDown(0.3);
  doc.text('Descrição: Créditos para geração de música por IA');
  doc.text(`Quantidade: ${order.creditsExpected}`);
  doc.text(`Valor unitário: R$ ${(order.amountBrl / order.creditsExpected).toFixed(2)}`);
  doc.text(`Valor total: R$ ${order.amountBrl.toFixed(2)}`);
  doc.text('Alíquotas de Impostos: conforme legislação vigente');

  doc.moveDown(1);
  doc.text('Dados da Transação PIX', { underline: true });
  doc.moveDown(0.3);
  doc.text(`TxID: ${transaction.providerId}`);
  doc.text(
    `Data/hora confirmação: ${
      pixInfo?.confirmedAt || order.confirmedAt || issueDate.toISOString()
    }`,
  );
  doc.text(`Valor pago: R$ ${order.amountBrl.toFixed(2)}`);

  doc.moveDown(1.5);
  const validationPayload = JSON.stringify({
    invoiceId,
    txid: transaction.providerId,
    amountBrl: order.amountBrl,
  });
  const hash = crypto
    .createHash('sha256')
    .update(validationPayload)
    .digest('hex');

  doc.fontSize(8);
  doc.text('Hash de integridade da NF:', { continued: true });
  doc.text(` ${hash}`);

  doc.text(
    'Valide esta nota acessando: https://app.canteeganhe.com/nf/validar',
  );

  doc.end();

  const buffer = await new Promise((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });

  const fileName = `${invoiceId}.pdf`;
  const filePath = path.join(invoicesDir, fileName);
  fs.writeFileSync(filePath, buffer);

  return {
    id: invoiceId,
    path: filePath,
    hash,
    createdAt: issueDate.toISOString(),
  };
};
