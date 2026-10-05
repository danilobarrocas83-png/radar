#!/usr/bin/env node
/* remessa.js — a rodada da madrugada do Radar Comercial (substitui o remessa_cnpj.py em 05/10/2026).

   O que faz, nesta ordem:
   1. Lê o radar (HTML do artifact) e o estado das marcações do time (pool/atividade.tsv).
   2. Reparte por igual, entre as filas ativas, os leads que ainda não receberam a primeira
      mensagem. Quem zerou a fila recebe dos outros. Lead trabalhado não muda de fila.
   3. Só quando a base não dá mais a cota do dia (30 por fila) é que completa com lead novo
      do pool, e só de empresas com capital declarado até R$ 200 mil.
   4. Terça e quinta (dia de follow-up): não entra lead novo e os follow-ups vencidos são
      repartidos por igual entre as filas; não grava leads_do_dia.json.
   5. Aplica o código do radar (scripts/radar_codigo.html) e grava a saída.
   As regras ficam em scripts/radar_fila.js; aqui é só leitura e gravação.

   Uso (na raiz do repositório):
     node scripts/remessa.js --html <radar.html lido do artifact> --key-file <arquivo da chave>
          [--atividade pool/atividade.tsv] [--max-idade-h 9] [--data AAAA-MM-DD] [--saida saida]
          [--codigo scripts/radar_codigo.html] [--repo-html radar.html] [--cap-max 200000]
     node scripts/remessa.js --teste-pool sim --key-file <arquivo da chave>   (só confere chave e estoque)

   Saída (pasta --saida): radar.html (GitHub), radar_nuvem.html (artifact, sem invólucro),
   leads_do_dia.json (os leads de hoje de cada fila, para as planilhas), leads_novos.json
   (só quando entrou lead novo) e resumo.txt.

   Códigos: 0 = gravou, publicar · 3 = o resultado é igual ao radar.html do repositório,
   nada a publicar (leads_do_dia.json e resumo.txt são gravados mesmo assim) · 1 = erro.
   Só imprime contagens: nunca nomes, telefones ou e-mails. */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const R = require("./radar_fila.js");

function args() {
  const a = { saida: "saida", atividade: "pool/atividade.tsv", codigo: "scripts/radar_codigo.html", "repo-html": "radar.html",
              pool: "pool", usados: "pool/usados.txt", "proximo-id": "pool/proximo_id.txt", "max-idade-h": "9", "cap-max": String(R.CAP_MAX) };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    if (v[i].slice(0, 2) !== "--") fim("argumento inesperado: " + v[i]);
    a[v[i].slice(2)] = v[i + 1]; i++;
  }
  return a;
}
function fim(msg) { console.log("ERRO: " + msg); process.exit(1); }
function le(p) { return fs.readFileSync(p, "utf8"); }
function existe(p) { return !!p && fs.existsSync(p); }

/* HMAC-SHA256 em modo contador: arquivo = nonce(16) || texto XOR keystream. */
function decifrar(dados, chave) {
  const nonce = dados.subarray(0, 16), ct = dados.subarray(16), out = Buffer.alloc(ct.length), ctr = Buffer.alloc(8);
  const n = Math.ceil(ct.length / 32);
  for (let i = 0; i < n; i++) {
    ctr.writeUInt32BE(Math.floor(i / 4294967296), 0); ctr.writeUInt32BE(i >>> 0, 4);
    const ks = crypto.createHmac("sha256", chave).update(nonce).update(ctr).digest();
    const s = i * 32, len = Math.min(32, ct.length - s);
    for (let j = 0; j < len; j++) out[s + j] = ct[s + j] ^ ks[j];
  }
  return out;
}
function lePool(dir, chaveHex) {
  const arqs = fs.readdirSync(dir).filter((n) => n.indexOf("candidatos") === 0 && n.indexOf(".enc") > 0).sort();
  if (!arqs.length) fim("nenhum arquivo de pool encontrado em " + dir);
  let rows = [];
  arqs.forEach((n) => {
    let raw = fs.readFileSync(path.join(dir, n));
    if (/\.txt$/.test(n)) raw = Buffer.from(raw.toString("latin1").replace(/\s+/g, ""), "base64");
    raw = decifrar(raw, Buffer.from(chaveHex, "hex"));
    let linhas;
    try { linhas = R.parsePool(raw.toString("utf8")); } catch (e) { fim(e.message + " em " + n); }
    rows = rows.concat(linhas);
  });
  return rows;
}

/* --teste-pool sim: só confere que a chave abre o pool e conta o estoque. Não grava nada.
   Serve para descobrir problema de chave ou de estoque ANTES do dia em que a base zerar. */
function testePool(a) {
  let chave = a.key || "";
  if (!chave && existe(a["key-file"])) chave = le(a["key-file"]).trim();
  if (chave.length !== 64) fim("chave do pool ausente ou invalida: passe --key-file <arquivo com 64 hex>");
  const capMax = parseFloat(a["cap-max"]);
  const pool = lePool(a.pool, chave), usados = {};
  if (existe(a.usados)) le(a.usados).split("\n").forEach((ln) => { const t = ln.trim(); if (t) usados[t] = 1; });
  const livres = pool.filter((c) => !usados[c.basico]);
  const noPorte = livres.filter((c) => { const v = parseFloat(c.capital); return !isNaN(v) && v <= capMax; });
  console.log("POOL OK: candidatos=" + pool.length + " ainda nao entregues=" + livres.length +
              " com capital ate R$ " + capMax + "=" + noPorte.length + " (com WhatsApp=" + noPorte.filter((c) => c.wa).length + ")");
  process.exit(0);
}

function main() {
  const a = args();
  if (a["teste-pool"]) testePool(a);
  if (!a.html) fim("faltou --html");
  const html = le(a.html);
  if (html.split("<!doctype html>").length !== 2 || html.split("</body></html>").length !== 2)
    fim("HTML sem o involucro esperado (esperava 1 <!doctype html> e 1 </body></html>)");
  const hoje = a.data || R.hojeFortaleza();
  const capMax = parseFloat(a["cap-max"]);
  const equipe = R.extraiVar(html, "EQUIPE_FIXA").valor;
  const leads = R.extraiVar(html, "LEADS_EMBUTIDOS").valor;
  const remanejo = R.extraiVar(html, "REMANEJO").valor;
  const resumo = [];

  /* estado do banco */
  let atividade = null, motivoSeguro = "";
  if (!existe(a.atividade)) motivoSeguro = "nao existe " + a.atividade;
  else {
    const t = R.parseTsvAtividade(le(a.atividade));
    const idadeH = (Date.now() - Date.parse(t.geradoUtc)) / 3600000;
    if (!t.geradoUtc || isNaN(idadeH)) motivoSeguro = a.atividade + " sem a data de geracao";
    else if (idadeH > parseFloat(a["max-idade-h"])) motivoSeguro = "o estado do banco e de " + t.geradoUtc + " (" + idadeH.toFixed(1) + " h atras; o limite e " + a["max-idade-h"] + " h)";
    else if (!t.linhas.length) motivoSeguro = a.atividade + " veio sem nenhuma marcacao";
    else { atividade = R.mapaAtividade(t.linhas); resumo.push("estado do banco: " + t.linhas.length + " marcacoes, gerado em " + t.geradoUtc + " (" + idadeH.toFixed(1) + " h atras)"); }
  }

  const plano = R.planejar({ equipe: equipe, leads: leads, atividade: atividade, hoje: hoje });
  resumo.unshift("data=" + hoje + " filas=" + plano.filas.length + " cota por fila: " + plano.filas.map((v) => v + "=" + plano.cota[v]).join(" "));
  if (plano.seguro) {
    resumo.push("MODO SEGURO: " + motivoSeguro + ". Sem saber quem ja foi trabalhado, a fila NAO foi redistribuida e NAO entrou lead novo.");
  } else {
    resumo.push("nao trabalhados na base=" + plano.U + " (cota do dia do time=" + plano.C + "; em filas inativas=" + plano.orfaos + ")");
    resumo.push("por fila, antes -> depois: " + plano.filas.map((v) => v + "=" + plano.livresAntes[v] + "->" + plano.livresDepois[v]).join(" "));
    resumo.push("movidos entre filas=" + plano.movidos + " devolvidos a quem ja tinha trabalhado=" + plano.corrigidos + " encerrados que sairam do radar=" + plano.removidos);
    resumo.push(plano.novosTotal ? ("BASE ZERADA: faltam " + plano.novosTotal + " para fechar a cota do dia; entram leads novos")
      : (plano.fupDia && !plano.baseCheia) ? "base zerando, mas hoje e dia de follow-up: lead novo so no proximo dia de lead novo"
      : ("sem lead novo: a base ainda cobre " + (plano.U / plano.C).toFixed(1) + " dia(s) de cota"));
    resumo.push("follow-ups vencidos na base=" + plano.fupTotal + " | por fila" + (plano.fupDia ? ", antes -> depois: " : ": ") +
                plano.filas.map((v) => v + "=" + plano.fupAntes[v] + (plano.fupDia ? "->" + plano.fupDepois[v] : "")).join(" "));
    resumo.push(plano.fupDia ? ("DIA DE FOLLOW-UP (terca e quinta): ninguem recebe lead novo hoje; follow-ups repassados entre filas=" + plano.fupRepassados)
                             : "dia de lead novo (segunda, quarta e sexta): follow-up fica com quem mandou a mensagem; o repasse e na terca e na quinta");
  }

  /* lead novo, só com a base zerada */
  let novos = [], proximo = null, escolhidos = [];
  if (plano.novosTotal > 0) {
    let chave = a.key || "";
    if (!chave && existe(a["key-file"])) chave = le(a["key-file"]).trim();
    if (chave.length !== 64) fim("chave do pool ausente ou invalida: passe --key-file <arquivo com 64 hex>");
    const pool = lePool(a.pool, chave);
    const usados = {};
    if (existe(a.usados)) le(a.usados).split("\n").forEach((ln) => { const t = ln.trim(); if (t) usados[t] = 1; });
    const sel = R.selecionarNovos({ pool: pool, leads: plano.leads, usados: usados, total: plano.novosTotal, capMax: capMax });
    escolhidos = sel.escolhidos;
    const idsExist = {};
    let maior = 0;
    leads.forEach((l) => { idsExist[l.id] = 1; });
    Object.keys(remanejo).forEach((k) => { idsExist[k] = 1; });
    Object.keys(idsExist).forEach((id) => { const m = /-(\d+)$/.exec(id); if (m) maior = Math.max(maior, parseInt(m[1], 10)); });
    proximo = maior + 1;
    if (existe(a["proximo-id"])) { const t = le(a["proximo-id"]).trim(); if (/^\d+$/.test(t)) proximo = Math.max(proximo, parseInt(t, 10)); }
    const mn = R.montarNovos({ escolhidos: escolhidos, plano: plano, hoje: hoje, proximo: proximo, idsExistentes: idsExist });
    novos = mn.novos;
    resumo.push.apply(resumo, sel.log);
    const porFila = {}, porNicho = {};
    let comWa = 0;
    novos.forEach((l) => { porFila[l.vend] = (porFila[l.vend] || 0) + 1; porNicho[l.nicho] = (porNicho[l.nicho] || 0) + 1; if (l.wa) comWa++; });
    resumo.push("novos=" + novos.length + " comWhatsApp=" + comWa + " ids " + proximo + ".." + (mn.proximo - 1));
    resumo.push("novos por fila: " + plano.filas.map((v) => v + "=" + (porFila[v] || 0)).join(" "));
    resumo.push("novos por nicho: " + Object.keys(porNicho).sort((x, y) => porNicho[y] - porNicho[x]).map((n) => n + "=" + porNicho[n]).join(" | "));
    resumo.push("restam no pool com capital ate R$ " + capMax + ": " + sel.restamNoPorte);
    proximo = mn.proximo;
  }

  const erros = R.conferir(leads, plano, novos, atividade);
  if (erros.length) fim("o plano nao passou na conferencia, nada foi gravado: " + erros.join(" | "));

  const lista = plano.leads.concat(novos);
  let codigo = null, codigoUsado = "do HTML lido";
  if (existe(a.codigo)) { codigo = le(a.codigo); codigoUsado = "de " + a.codigo + " (" + codigo.length + " chars)"; }
  const htmlNovo = R.montarHtml(html, lista, codigo);
  const igual = existe(a["repo-html"]) && R.linhasUteis(le(a["repo-html"])) === R.linhasUteis(htmlNovo);
  resumo.push("total embutido=" + lista.length + " (antes " + leads.length + ")");
  resumo.push("codigo do radar: " + codigoUsado);
  resumo.push(igual ? "RESULTADO: igual ao radar.html do repositorio - nada a publicar (saida 3)" : "RESULTADO: radar.html mudou - publicar artifact + GitHub (saida 0)");

  fs.mkdirSync(a.saida, { recursive: true });
  fs.writeFileSync(path.join(a.saida, "radar.html"), htmlNovo);
  fs.writeFileSync(path.join(a.saida, "radar_nuvem.html"), R.semInvolucro(htmlNovo));
  ["leads_do_dia.json", "leads_novos.json"].forEach((n) => { const p = path.join(a.saida, n); if (fs.existsSync(p)) fs.unlinkSync(p); });
  /* em dia de follow-up não há lead novo para ninguém: sem lista do dia, sem planilha */
  if (!plano.seguro && !plano.fupDia) {
    const planoFinal = { filas: plano.filas, cota: plano.cota, leads: lista };
    fs.writeFileSync(path.join(a.saida, "leads_do_dia.json"), JSON.stringify(R.leadsDoDia(planoFinal, atividade), null, 1));
  }
  if (novos.length) {
    fs.writeFileSync(path.join(a.saida, "leads_novos.json"), JSON.stringify(novos, null, 1));
    fs.appendFileSync(a.usados, escolhidos.slice(0, novos.length).map((c) => c.basico + "\n").join(""));
    fs.writeFileSync(a["proximo-id"], String(proximo) + "\n");
  }
  fs.writeFileSync(path.join(a.saida, "resumo.txt"), resumo.join("\n") + "\n");
  console.log(resumo.join("\n"));
  process.exit(igual ? 3 : 0);
}

main();
