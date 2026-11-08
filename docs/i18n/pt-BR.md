# Glossary: Brazilian Portuguese (pt-BR)

The terms ZeroGap's apps and GapWallet use in Brazilian Portuguese, so the
same thing has the same name everywhere. The user decides them; translators
follow them and propose changes here, not in a catalog alone.

`tools/i18n.py check --lang pt-BR` reads the table below: a translation
with a word from the "Avoid" column is reported. Rows are matched by whole
words, ignoring case.

## Style

- Address the user as "você". Buttons and menu items are infinitives
  ("Adicionar esta conta", "Copiar"); instructions are imperatives
  ("Escolha uma rede", "Digite um valor").
- "Transação" and "PSBT" are feminine ("a PSBT está assinada"); "QR code"
  is masculine and stays in English.
- Never translated: ZeroGap, GapWallet, dice39, codex32, BIP numbers, script
  and key formats (P2WPKH, zpub, xpub, Base43, BBQr), units (BTC, sat,
  sat/vB), network names (mainnet, testnet, signet).
- Numbers, amounts and dates come from zg:i18n (`formatBtc`, `formatDate`...),
  never typed into a translation.

## Terms

| English | pt-BR | Avoid | Notes |
|---|---|---|---|
| share (codex32, a split secret) | partição | parte, partes | "Partição 1 de 3"; feminine, as "parte" was |
| passphrase (BIP-39) | frase-senha | passphrase, senha | "senha" alone is a password |
| seed | semente | seed | the BIP-32/BIP-39 seed |
| seed phrase, recovery phrase | frase-semente | | "a frase" once it is clear |
| threshold (codex32) | limiar | | "limiar 2": any 2 partições recover it |
| master fingerprint | Identificador-Mestre | impressão digital | capitalized as a label; "o identificador-mestre" in a sentence |
| watch-only | somente leitura | somente observação | |
| scan (a wallet's addresses, on a server) | coleta, coletar | varredura | "Coletando…" |
| scan (a QR code, with a camera) | ler, leitura | | "Ler com a câmera" |
| gap limit | lacuna-limite | limite de intervalo | |
| handed out (an address) | passado adiante | | |
| account | conta | | |
| descriptor | descritor | | |
| address | endereço | | "endereço de recebimento", "endereço de troco" |
| change (output) | troco | | |
| fee | taxa | | "taxa (sat/vB)" for a fee rate |
| amount | valor | quantia | |
| coin (an unspent output) | moeda | | also the coin of dice39's coin flip: context tells |
| balance | saldo | | |
| sign, signer | assinar, assinador | | |
| wallet | carteira | | |
| network | rede | | |
| public key, private key | chave pública, chave privada | | |
| derivation path | caminho de derivação | | |
| hardened | endurecido (hardened) | | English in parentheses the first time on a page |
| entropy | entropia | | |
| checksum | checksum | | kept in English, as on dice39's pages |
| dice, die | dados, dado | | |
| Done | Concluir | | |
| Back | Voltar | | |
| Cancel | Cancelar | | |
| Settings | Configurações | | |
| Language | Idioma | | |
| keyboard | teclado | | |
| Prepare for Signing | Preparar para Assinatura | | GapWallet |
| Sign it Externally | Assine Externamente | | GapWallet |
