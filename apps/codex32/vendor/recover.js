// Extracted from dice39 by tools/extract_codex32.py - do not edit.
// Source: codex32_recover.html (sha256 6ab1b53c74045669cad1c449c1208288aed386b52c130b15d26daf8ac5723606), page script (selected declarations) starting at line 13046.
// dice39 is licensed under the GNU AGPL v3; see apps/codex32/LICENSE-dice39.txt.
// The code between the prelude and the export line is copied verbatim.

import { BIP39_WORDS } from "./wordlist.js";
const window = { BIP39_WORDS };

/* ==================================================================
   i18n
   ================================================================== */
const STRINGS = {
en: {
  pageTitle: 'codex32 recover — dice39',
  h1Title: 'Recombine codex32 shares',
  subtitle: 'Rebuilds a BIP-39 phrase (12 or 24 words) from shares made by dice39.',
  warnHtml: 'Do this on the <b>same offline machine</b> you will use the phrase on. The moment enough shares are in one place, the seed exists again — that is the point of the exercise and also its whole risk. Close this page when you are done, and do not leave the shares in a text file.',
  inputHeading: 'Paste your shares',
  inputHelp: 'One per line. You need exactly as many as the threshold the shares were made with — a 2-of-3 split needs 2, no more and no fewer. Case does not matter.',
  scanBtn: 'Scan with camera',
  scanStop: 'Stop camera',
  scanStarting: 'Starting the camera\u2026',
  scanAiming: 'Point the camera at a share QR. {n} collected so far.',
  scanAdded: 'Added share index {i}. {n} of {k} collected.',
  scanEnough: 'Got {k} of {k}. Camera stopped \u2014 press Recover.',
  scanDuplicate: 'That is share index {i}, which you already have.',
  scanNotShare: 'That QR is not a codex32 share.',
  scanMismatch: 'That share belongs to a different split ({id}, threshold {k}).',
  scanUnsupported: 'The QR decoder did not load, so scanning is unavailable. Type or paste the shares instead \u2014 every share is printed as text under its QR.',
  scanDenied: 'The camera was refused. Allow access, or type the shares instead.',
  scanNoCamera: 'No camera was found. Type the shares instead.',
  recoverBtn: 'Recover the phrase',
  exportHeading: 'Getting the phrase off this page',
  exportCompareHtml: '<p>The shares you just combined were the safe form of this secret \u2014 no one of them was worth stealing. What is on screen now is the whole of it in one place, and every way out of here carries all of it.</p><ul><li><button type="button" class="tablink" data-tab="tabCopy">Clipboard</button> \u2014 quickest, simplest, crudest, and riskiest for exactly those reasons: every program on this machine can read it, it may sync to your other devices, and a clipboard manager may keep it long after you have moved on.</li><li><button type="button" class="tablink" data-tab="tabWords">QR of the words</button> \u2014 the same secret carried by light rather than a cable, which is what makes an air-gapped machine practical. The price is a camera, a lit screen, and whatever else can see either.</li><li><button type="button" class="tablink" data-tab="tabSeed">SeedQR and Compact SeedQR</button> \u2014 the same exposure in a different notation, for wallets that read these and not plain text. A different format, not a safer one.</li></ul><p>When you are done here, close the page. The shares are what this secret should go back to living as.</p>',
  copyIntro: 'Use this if your wallet software is running on this same machine. If the wallet is on another device, use the QR export below instead.',
  copyWarningHtml: 'The clipboard is shared with every program running on this machine, and anything that can read it gets your whole seed — no camera, no photo, no trace. Paste it into your wallet straight away, then copy something else so the seed does not sit there. Bear in mind the clipboard may be synced to your other devices, and may survive in a clipboard-history tool.',
  copyConfirmLabel: 'I am reasonably confident there is no virus or malware on this machine that could read the clipboard.',
  copyBtn: 'Copy the {t} words',
  copyOk: 'Copied. Paste it into your wallet now, then copy something else to overwrite it.',
  copyFail: 'This browser would not give the page access to the clipboard. Type the words in by hand from the list above, or use the QR export.',
  qrIntro: 'Use this if your wallet is on another device — a hardware wallet, or a phone.',
  qrWarningHtml: 'A QR code of your seed is scannable the instant a camera sees it. Only reveal this on your air-gapped device, scan it live with the importing wallet\u2019s camera, and never let it sit as a saved photo (camera roll, cloud backup, screenshot). Prefer the 3-part split below if your wallet supports scanning multiple codes \u2014 it raises the bar against an opportunistic single photo, though each part alone still leaks those 8 words in the clear.',
  qrConfirmLabel: 'I understand this reveals my seed as a scannable code, and I will scan it live rather than save it.',
  qrBtnSingle: 'Show single QR (all {t} words)',
  qrBtnSplit: 'Show 3-part QR (8 + 8 + 8 words)',
  qrLabelSingle: 'All {t} words \u2014 scan live, do not screenshot',
  qrLabelSplit: 'Words {a}\u2013{b} of {t} \u2014 scan live, do not screenshot',
  qrBtnSeed: 'Show SeedQR (SeedSigner format)',
  qrBtnCompact: 'Show Compact SeedQR (smallest grid)',
  qrLabelSeed: 'SeedQR, {g} \u2014 scan live, do not screenshot',
  qrLabelCompact: 'Compact SeedQR, {g} \u2014 scan live, do not screenshot',
  qrFormatNote: 'Both carry the same seed as numbers rather than words. SeedQR spells out each word\u2019s position in the BIP-39 list; Compact SeedQR carries only the entropy, so its grid is one size smaller \u2014 quicker to scan, and appreciably less work to copy by hand onto metal. A wallet that reads one of these often reads neither the other nor the plain words, so check what yours takes before you rely on it.',
  tabCopyLabel: 'Clipboard',
  tabWordsLabel: 'QR of the words',
  tabSeedLabel: 'SeedQR',
  tabHint: 'Pick one above. Nothing is revealed until you do \u2014 and only one is ever on screen at a time.',
  seedIntro: 'Use this if the wallet you are restoring into reads SeedSigner-style codes rather than a line of text \u2014 SeedSigner itself, Krux, and others that followed them.',
  seedWarningHtml: 'These carry exactly what the words carry, in a notation no human reads back \u2014 which cuts both ways. Nothing on the code says what it is, so nothing warns whoever finds it, and a <b>Compact SeedQR is the whole secret in 32 anonymous bytes</b>. Reveal it only on your air-gapped device, scan it live with the importing wallet\u2019s camera, and never let it sit as a saved photo (camera roll, cloud backup, screenshot).',
  seedConfirmLabel: 'I understand these codes are the recovered seed in another notation, and I will scan them live rather than save them.',
  clearBtn: 'Clear',
  resultHeading: 'Recovered phrase',
  entropyLabel: 'Entropy ({bytes} bytes, hex)',
  secretLabel: 'codex32 secret (index s)',
  resultNote: 'Type these {t} words into your wallet in this order. This is a BIP-39 phrase: give it to a wallet as a BIP-39 recovery phrase, not as a raw BIP-32 seed.',
  metaThreshold: 'Threshold',
  metaId: 'Identifier',
  metaShares: 'Shares used',
  errPrefix: 'Could not recover: ',
  errNoShares: 'Paste at least two shares, one per line.',
  errWrongSize: 'These shares carry {n} bytes. dice39 makes 16-byte seeds (12 words) and 32-byte seeds (24 words), and {n} is neither — recovery stopped rather than guess.',
  footerHtml: 'Free software under the <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener">GNU AGPL v3</a> or later; this page is its complete source. Source, issues and patches: <a href="https://github.com/marcocarnut/dice39" target="_blank" rel="noopener">github.com/marcocarnut/dice39</a>. Implements <a href="https://github.com/bitcoin/bips/blob/master/bip-0093.mediawiki" target="_blank" rel="noopener">BIP-93 (codex32)</a>. Bundled: the BIP-39 wordlist (MIT), <a href="https://github.com/cozmo/jsQR" target="_blank" rel="noopener">jsQR</a> for reading QR codes (Apache-2.0) and <a href="https://github.com/kazuhikoarase/qrcode-generator" target="_blank" rel="noopener">qrcode-generator</a> for writing them (MIT, Kazuhiko Arase).'
},
pt: {
  pageTitle: 'codex32 recuperar — dice39',
  h1Title: 'Recombinar partes codex32',
  subtitle: 'Reconstrói uma frase BIP-39 (de 12 ou 24 palavras) a partir de partes feitas pelo dice39.',
  warnHtml: 'Faça isto na <b>mesma máquina off-line</b> em que vai usar a frase. No instante em que partes suficientes estão no mesmo lugar, o seed existe de novo — esse é o objetivo do exercício e também todo o seu risco. Feche esta página ao terminar, e não deixe as partes num arquivo de texto.',
  inputHeading: 'Cole as suas partes',
  inputHelp: 'Uma por linha. Você precisa de exatamente tantas quanto o limiar com que as partes foram feitas — uma divisão 2 de 3 precisa de 2, nem mais nem menos. Maiúsculas e minúsculas não importam.',
  scanBtn: 'Ler com a c\u00e2mera',
  scanStop: 'Parar a c\u00e2mera',
  scanStarting: 'Iniciando a c\u00e2mera\u2026',
  scanAiming: 'Aponte a c\u00e2mera para o QR de uma parte. {n} lidas at\u00e9 agora.',
  scanAdded: 'Parte de \u00edndice {i} adicionada. {n} de {k} lidas.',
  scanEnough: 'Voc\u00ea tem {k} de {k}. C\u00e2mera parada \u2014 clique em Recuperar.',
  scanDuplicate: 'Esta \u00e9 a parte de \u00edndice {i}, que voc\u00ea j\u00e1 tem.',
  scanNotShare: 'Este QR n\u00e3o \u00e9 uma parte codex32.',
  scanMismatch: 'Esta parte pertence a outra divis\u00e3o ({id}, limiar {k}).',
  scanUnsupported: 'O decodificador de QR n\u00e3o carregou, ent\u00e3o a leitura est\u00e1 indispon\u00edvel. Digite ou cole as partes \u2014 cada parte vem impressa como texto embaixo do seu QR.',
  scanDenied: 'A c\u00e2mera foi recusada. Permita o acesso, ou digite as partes.',
  scanNoCamera: 'Nenhuma c\u00e2mera encontrada. Digite as partes.',
  recoverBtn: 'Recuperar a frase',
  exportHeading: 'Tirar a frase desta página',
  exportCompareHtml: '<p>As partições que você acabou de combinar eram a forma segura deste segredo \u2014 nenhuma delas sozinha valia ser roubada. O que está na tela agora é o segredo inteiro, num lugar só, e toda saída daqui leva o todo.</p><ul><li><button type="button" class="tablink" data-tab="tabCopy">Área de transferência</button> \u2014 a mais rápida, a mais simples, a mais crua, e a mais arriscada exatamente por isso: todo programa nesta máquina consegue lê-la, ela pode estar sincronizada com os seus outros dispositivos, e um histórico de área de transferência pode guardá-la muito depois de você ter seguido em frente.</li><li><button type="button" class="tablink" data-tab="tabWords">QR das palavras</button> \u2014 o mesmo segredo levado por luz em vez de cabo, que é o que torna prática uma máquina isolada da rede. O preço é uma câmera, uma tela acesa, e o que mais conseguir enxergar as duas.</li><li><button type="button" class="tablink" data-tab="tabSeed">SeedQR e Compact SeedQR</button> \u2014 a mesma exposição em outra notação, para carteiras que leem estes e não texto puro. Um formato diferente, não um mais seguro.</li></ul><p>Quando terminar aqui, feche a página. As partições são a forma em que este segredo deve voltar a viver.</p>',
  copyIntro: 'Use isto se o seu programa de carteira estiver rodando nesta mesma m\u00e1quina. Se a carteira estiver em outro dispositivo, use a exporta\u00e7\u00e3o por QR abaixo.',
  copyWarningHtml: 'A \u00e1rea de transfer\u00eancia \u00e9 compartilhada com todos os programas rodando nesta m\u00e1quina, e qualquer um que consiga l\u00ea-la fica com o seu seed inteiro \u2014 sem c\u00e2mera, sem foto, sem deixar rastro. Cole na sua carteira imediatamente e depois copie outra coisa, para o seed n\u00e3o ficar parado ali. Lembre-se de que a \u00e1rea de transfer\u00eancia pode estar sincronizada com os seus outros dispositivos, e pode sobreviver em um hist\u00f3rico de \u00e1rea de transfer\u00eancia.',
  copyConfirmLabel: 'Tenho razo\u00e1vel certeza de que n\u00e3o h\u00e1 v\u00edrus nem malware nesta m\u00e1quina capaz de ler a \u00e1rea de transfer\u00eancia.',
  copyBtn: 'Copiar as {t} palavras',
  copyOk: 'Copiado. Cole na sua carteira agora e depois copie outra coisa para sobrescrever.',
  copyFail: 'Este navegador n\u00e3o deu \u00e0 p\u00e1gina acesso \u00e0 \u00e1rea de transfer\u00eancia. Digite as palavras \u00e0 m\u00e3o a partir da lista acima, ou use a exporta\u00e7\u00e3o por QR.',
  qrIntro: 'Use isto se a sua carteira estiver em outro dispositivo \u2014 uma hardware wallet, ou um celular.',
  qrWarningHtml: 'Um QR code do seu seed é escaneável no instante em que uma câmera o vê. Só revele isto no seu dispositivo isolado da rede, escaneie ao vivo com a câmera da carteira que vai importar, e nunca deixe ficar como foto salva (galeria, backup na nuvem, print de tela). Prefira a divisão em 3 partes abaixo se sua carteira suportar escanear vários códigos \u2014 isso eleva a barreira contra uma foto oportunista única, embora cada parte sozinha ainda revele 8 palavras em texto claro.',
  qrConfirmLabel: 'Entendo que isto revela meu seed como um código escaneável, e vou escaneá-lo ao vivo em vez de salvá-lo.',
  qrBtnSingle: 'Mostrar QR único ({t} palavras)',
  qrBtnSplit: 'Mostrar QR em 3 partes (8 + 8 + 8 palavras)',
  qrLabelSingle: 'Todas as {t} palavras \u2014 escaneie ao vivo, não tire print',
  qrLabelSplit: 'Palavras {a}\u2013{b} de {t} \u2014 escaneie ao vivo, não tire print',
  qrBtnSeed: 'Mostrar SeedQR (formato SeedSigner)',
  qrBtnCompact: 'Mostrar Compact SeedQR (grade menor)',
  qrLabelSeed: 'SeedQR, {g} \u2014 escaneie ao vivo, não tire print',
  qrLabelCompact: 'Compact SeedQR, {g} \u2014 escaneie ao vivo, não tire print',
  qrFormatNote: 'Os dois levam a mesma semente como números, e não como palavras. O SeedQR escreve a posição de cada palavra na lista BIP-39; o Compact SeedQR leva só a entropia, então sua grade é um tamanho menor \u2014 mais rápida de escanear, e bem menos trabalho para copiar à mão em metal. Uma carteira que lê um destes muitas vezes não lê nem o outro nem as palavras em texto, então confira o que a sua aceita antes de depender dela.',
  tabCopyLabel: 'Área de transferência',
  tabWordsLabel: 'QR das palavras',
  tabSeedLabel: 'SeedQR',
  tabHint: 'Escolha uma acima. Nada é revelado antes disso \u2014 e só uma fica na tela por vez.',
  seedIntro: 'Use isto se a carteira em que você vai restaurar lê códigos no estilo SeedSigner em vez de uma linha de texto \u2014 o próprio SeedSigner, o Krux, e outros que vieram depois deles.',
  seedWarningHtml: 'Estes levam exatamente o que as palavras levam, numa notação que nenhum humano lê de volta \u2014 o que corta dos dois lados. Nada no código diz o que ele é, então nada avisa quem o encontrar, e um <b>Compact SeedQR é o segredo inteiro em 32 bytes anônimos</b>. Só revele no seu dispositivo isolado da rede, escaneie ao vivo com a câmera da carteira que vai importar, e nunca deixe ficar como foto salva (galeria, backup na nuvem, print de tela).',
  seedConfirmLabel: 'Entendo que estes códigos são a semente recuperada em outra notação, e vou escaneá-los ao vivo em vez de salvá-los.',
  clearBtn: 'Limpar',
  resultHeading: 'Frase recuperada',
  entropyLabel: 'Entropia ({bytes} bytes, hex)',
  secretLabel: 'Segredo codex32 (índice s)',
  resultNote: 'Digite estas {t} palavras na sua carteira nesta ordem. Isto é uma frase BIP-39: entregue-a à carteira como frase de recuperação BIP-39, e não como semente BIP-32 bruta.',
  metaThreshold: 'Limiar',
  metaId: 'Identificador',
  metaShares: 'Partes usadas',
  errPrefix: 'Não foi possível recuperar: ',
  errNoShares: 'Cole pelo menos duas partes, uma por linha.',
  errWrongSize: 'Estas partes carregam {n} bytes. O dice39 gera seeds de 16 bytes (12 palavras) e de 32 bytes (24 palavras), e {n} não é nenhum dos dois — a recuperação parou em vez de adivinhar.',
  footerHtml: 'Software livre sob a <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener">GNU AGPL v3</a> ou posterior; esta página é o seu código-fonte completo. Código, problemas e contribuições: <a href="https://github.com/marcocarnut/dice39" target="_blank" rel="noopener">github.com/marcocarnut/dice39</a>. Implementa o <a href="https://github.com/bitcoin/bips/blob/master/bip-0093.mediawiki" target="_blank" rel="noopener">BIP-93 (codex32)</a>. Inclui: a lista de palavras BIP-39 (MIT), o <a href="https://github.com/cozmo/jsQR" target="_blank" rel="noopener">jsQR</a> para ler QR codes (Apache-2.0) e o <a href="https://github.com/kazuhikoarase/qrcode-generator" target="_blank" rel="noopener">qrcode-generator</a> para gerá-los (MIT, Kazuhiko Arase).'
}
};

/* ==================================================================
   entropy -> BIP-39 words (the step a generic BIP-93 tool will not do)
   ================================================================== */
/* 16 bytes -> 12 words, 32 bytes -> 24. The checksum is entropy/32 bits taken
   from the TOP of SHA-256(entropy): the whole first byte at 32 bytes, its high
   nibble at 16. Taking the low nibble instead would produce twelve perfectly
   valid-looking words for a different wallet, so the shift is written once and
   derived, never spelled out per length. */
const RECOVER_SIZES = { 16: { words: 12, checksumBits: 4 }, 32: { words: 24, checksumBits: 8 } };

async function wordsFromEntropy(entropy) {
  const spec = RECOVER_SIZES[entropy.length];
  if (!spec) throw new Error('expected 16 or 32 bytes, got ' + entropy.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', entropy));
  const bits = [];
  for (const b of entropy) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  for (let i = 0; i < spec.checksumBits; i++) bits.push((digest[0] >> (7 - i)) & 1);
  const words = [];
  for (let i = 0; i < spec.words; i++) {
    let idx = 0;
    for (let j = 0; j < 11; j++) idx = (idx << 1) | bits[i * 11 + j];
    words.push(window.BIP39_WORDS[idx]);
  }
  return words;
}

const hex = b => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');

/* The two SeedSigner encodings, as on the generator -- see the long note
   beside seedQrDigits() there. SeedQR is 0-based wordlist positions, four
   digits each, in Numeric mode; Compact SeedQR is the seed itself in Binary
   mode, which on this page is simply what cxRecover handed back. Both at
   error-correction L, to land on the grid sizes the printed transcription
   templates are cut to. */
const SEEDQR_ECC = 'L';

function seedQrDigits(words) {
  return words.map(w => {
    const i = window.BIP39_WORDS.indexOf(w);
    if (i < 0) throw new Error('not a BIP-39 word: ' + w);
    return String(i).padStart(4, '0');
  }).join('');
}

export { STRINGS, RECOVER_SIZES, wordsFromEntropy, hex, SEEDQR_ECC, seedQrDigits };
