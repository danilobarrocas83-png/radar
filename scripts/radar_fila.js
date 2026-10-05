/* radar_fila.js — as regras da fila do Radar Comercial (pedido do Danilo, 05/10/2026).

   - Cada fila (vendedor ativo, mais o gestor quando prospecta) recebe por dia a sua cota de
     leads novos (30). Eles saem da fila de quem ainda não recebeu a primeira mensagem.
   - Enquanto a base tiver lead sem trabalhar, não entra lead novo: os que sobram são
     repartidos por igual entre as filas toda madrugada. Quem zera a fila recebe dos outros.
   - Lead novo só entra quando a base não dá mais a cota do dia para todo mundo, e só de
     empresas com capital declarado até R$ 200 mil.
   - Terça e quinta são dia de follow-up: não entra lead novo, e os follow-ups vencidos são
     repartidos por igual entre as filas, para ninguém ficar sem trabalho e nenhum lead ficar
     sem os três contatos (primeira mensagem, follow-up 1 e follow-up 2). O lead repassado
     leva junto o estado em que estava (campo `her`); a mensagem sai no nome de quem envia.
   - Fora desse repasse, lead trabalhado não muda de fila: ele é de quem marcou.

   Este arquivo não lê nem grava nada: recebe os dados e devolve o plano. Quem lê e grava
   é o scripts/remessa.js (rotina) e o scripts/le_banco.js (GitHub Actions). Assim as
   mesmas regras rodam no Node e, para teste, dentro de um navegador.

   ordemFila() e capDoGancho() existem também no código do radar (scripts/radar_codigo.html):
   é a ordem em que os leads entram no dia do vendedor. Não mude um sem mudar o outro. */
(function (root) {
  "use strict";

  var CAP_MAX = 200000;
  var COTA_PADRAO = 30;
  /* por quantos dias um lead já encerrado continua no radar depois do último toque. Quem
     ainda deve follow-up (contatado, fup1) nunca sai: os três contatos são obrigação. */
  var GUARDA = { perdido: 5, bloqueado: 5, fup2: 7, aberto: 21 };
  var FUP1_DIAS = 2, FUP2_DIAS = 2;
  /* terça (2) e quinta (4): dia de follow-up */
  function diaDeFollowup(iso) {
    var d = new Date(iso + "T12:00:00Z").getUTCDay();
    return d === 2 || d === 4;
  }
  /* O estado do lead para quem cuida dele hoje: a marcação do dono; se ele recebeu o lead
     já trabalhado e ainda não marcou nada, o estado que veio junto no repasse. */
  function estadoDe(l, at) {
    var regs = at[l.id];
    if (regs && regs[l.vend]) return regs[l.vend];
    if (regs && l.her && l.her.s) return { s: l.her.s, d: l.her.d, m: l.her.m || "" };
    return null;
  }
  /* follow-up da cadência vencido (o de recepção tem texto próprio e fica com o dono) */
  function fupVencido(r, hoje) {
    if (!r) return false;
    var dias = diasEntre(r.d, hoje);
    if (r.s === "contatado" && r.m !== "recepcao") return dias >= FUP1_DIAS;
    if (r.s === "fup1") return dias >= FUP2_DIAS;
    return false;
  }
  var COLS = ["basico", "cnpj", "empresa", "nicho", "bloco", "cidade", "uf", "wa", "tel", "email", "gancho", "oferta",
              "prio", "score", "dataInicio", "porte", "natureza", "capital", "rnd", "key", "phoneKey"];

  /* ---------- texto ---------- */
  function norm(s) {
    return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, " ").replace(/^ +| +$/g, "");
  }
  function slug(s) {
    var t = norm(s).replace(/\s+/g, "-").replace(/^-+|-+$/g, "");
    if (t.length > 40) t = t.slice(0, 40).replace(/-+$/, "");
    return t || "empresa";
  }
  function digitos(s) { return String(s || "").replace(/\D/g, ""); }

  /* ---------- HTML ---------- */
  /* Índice logo depois do fim do valor JSON que começa em i ([ ou {). */
  function fimJson(s, i) {
    var prof = 0, emStr = false, c, k;
    for (k = i; k < s.length; k++) {
      c = s.charCodeAt(k);
      if (emStr) { if (c === 92) k++; else if (c === 34) emStr = false; continue; }
      if (c === 34) { emStr = true; continue; }
      if (c === 91 || c === 123) prof++;
      else if (c === 93 || c === 125) { prof--; if (prof === 0) return k + 1; }
    }
    throw new Error("JSON sem fim no HTML");
  }
  /* Valor, início e fim do JSON logo depois de `var NOME=`. */
  function extraiVar(html, nome) {
    var i = html.indexOf("var " + nome + "=");
    if (i < 0) throw new Error("nao achei var " + nome + " no HTML");
    var j = html.indexOf("=", i) + 1;
    while (/\s/.test(html.charAt(j))) j++;
    var f = fimJson(html, j);
    return { valor: JSON.parse(html.slice(j, f)), ini: j, fim: f };
  }
  /* Troca a lista de leads e, se vier, o código do radar (tudo depois do </script> dos leads). */
  function montarHtml(html, leads, codigo) {
    var e = extraiVar(html, "LEADS_EMBUTIDOS");
    var arr = JSON.stringify(leads).replace(/<\//g, "<\\/");
    var novo = html.slice(0, e.ini) + arr + html.slice(e.fim);
    if (codigo) {
      var fimLeads = novo.indexOf("</script>", novo.indexOf("var LEADS_EMBUTIDOS="));
      if (fimLeads < 0) throw new Error("nao achei o </script> dos leads");
      if (codigo.split("</body></html>").length !== 2 || codigo.indexOf("<script") < 0)
        throw new Error("o codigo do radar nao parece o codigo do radar (esperava 1 </body></html> e <script>)");
      novo = novo.slice(0, fimLeads + 9) + codigo;
    }
    return novo;
  }
  function semInvolucro(h) {
    var b = h.indexOf("<body>"), e = h.lastIndexOf("</body>");
    return h.slice(b + 6, e);
  }
  function linhasUteis(h) {
    return h.replace(/\r/g, "").split("\n").filter(function (ln) { return ln.replace(/\s/g, "") !== ""; }).join("\n");
  }

  /* ---------- datas ---------- */
  function hojeFortaleza(agora) {
    return new Date((agora || Date.now()) - 3 * 3600 * 1000).toISOString().slice(0, 10);
  }
  function diasEntre(a, b) {
    var x = Date.parse(a + "T00:00:00Z"), y = Date.parse(b + "T00:00:00Z");
    return (isNaN(x) || isNaN(y)) ? NaN : Math.round((y - x) / 86400000);
  }
  function diaDoAno(iso) { return diasEntre(iso.slice(0, 4) + "-01-01", iso) + 1; }

  /* ---------- a ordem da fila ---------- */
  /* Capital declarado, lido do "sinal no cadastro" ("capital R$ 800 mil", "capital R$ 1,2 mi"). */
  function capDoGancho(g) {
    var m = /capital R\$\s*([\d.,]+)\s*(mil|mi)?/i.exec(String(g || ""));
    if (!m) return 0;
    var n = parseFloat(m[1].replace(/\./g, "").replace(",", "."));
    if (isNaN(n)) return 0;
    if (m[2]) n *= (m[2].toLowerCase() === "mil" ? 1e3 : 1e6);
    return Math.round(n);
  }
  var PESO_PRIO = { A: 0, B: 1, C: 2 };
  /* Primeiro quem está no porte (capital até R$ 200 mil), depois prioridade, quem tem
     WhatsApp, o lote mais antigo e o id. */
  function ordemFila(a, b) {
    var ca = (+a.cap || 0) > CAP_MAX ? 1 : 0, cb = (+b.cap || 0) > CAP_MAX ? 1 : 0;
    if (ca !== cb) return ca - cb;
    var pa = PESO_PRIO[a.prio] !== undefined ? PESO_PRIO[a.prio] : 3, pb = PESO_PRIO[b.prio] !== undefined ? PESO_PRIO[b.prio] : 3;
    if (pa !== pb) return pa - pb;
    var wa = a.wa ? 0 : 1, wb = b.wa ? 0 : 1;
    if (wa !== wb) return wa - wb;
    var la = String(a.loteData || ""), lb = String(b.loteData || "");
    if (la !== lb) return la < lb ? -1 : 1;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  }

  /* ---------- estado do banco (pool/atividade.tsv) ---------- */
  /* Lê a tabela atividade inteira, de 1000 em 1000 (limite do Supabase por pedido). */
  function lerAtividade(fetchFn, base, chaves) {
    var caminho = "atividade?select=vend,lead,s,m,d&order=vend.asc,lead.asc";
    function comChave(k) {
      var tudo = [], passo = 1000;
      function pagina(ini) {
        return fetchFn(base + caminho, { headers: {
          "apikey": chaves[k], "Authorization": "Bearer " + chaves[k], "Accept": "application/json",
          "Range-Unit": "items", "Range": ini + "-" + (ini + passo - 1) } })
          .then(function (r) {
            if (r.status === 416) return tudo;
            if ((r.status === 401 || r.status === 403) && k + 1 < chaves.length) return comChave(k + 1);
            if (r.status !== 200 && r.status !== 206) throw new Error("HTTP " + r.status + " na pagina que comeca em " + ini);
            return r.json().then(function (pg) {
              if (!Array.isArray(pg)) throw new Error("resposta inesperada do banco");
              tudo = tudo.concat(pg);
              return pg.length < passo ? tudo : pagina(ini + passo);
            });
          });
      }
      return pagina(0);
    }
    return comChave(0);
  }
  /* URL e chaves públicas do banco, as mesmas que o radar usa (var SB = {...}). */
  function bancoDoHtml(html) {
    var i = html.indexOf("var SB = {");
    if (i < 0) throw new Error("nao achei 'var SB = {' no HTML");
    var bloco = html.slice(i, i + 1500);
    var u = /url:\s*"([^"]+)"/.exec(bloco), k = /keys:\s*\[([^\]]+)\]/.exec(bloco);
    if (!u || !k) throw new Error("nao consegui ler url/keys do banco no HTML");
    var chaves = (k[1].match(/"([^"]+)"/g) || []).map(function (x) { return x.slice(1, -1); });
    if (!chaves.length) throw new Error("nenhuma chave publica no HTML");
    return { base: u[1].replace(/\/+$/, "") + "/rest/v1/", chaves: chaves };
  }
  /* Só o que a rotina precisa: lead, vendedor, status, data e o botão marcado, dos leads
     que estão no radar. */
  function tsvAtividade(linhas, ids, agoraIso) {
    var uteis = [];
    linhas.forEach(function (x) {
      var v = String((x && x.vend) || ""), l = String((x && x.lead) || ""), s = String((x && x.s) || "");
      var m = String((x && x.m) || "").replace(/[^a-z_]/g, "");
      if (!v || !l || !s || !ids[l] || /[\t\n\r]/.test(v + l + s)) return;
      uteis.push([l, v, s, String(x.d || "").slice(0, 10), m]);
    });
    uteis.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0); });
    var nIds = 0, k; for (k in ids) nIds++;
    var t = "# gerado_utc=" + agoraIso + " linhas=" + uteis.length + " linhas_banco=" + linhas.length + " leads_no_radar=" + nIds + "\n" +
            "lead\tvend\ts\td\tm\n";
    uteis.forEach(function (u) { t += u.join("\t") + "\n"; });
    return { texto: t, linhas: uteis.length };
  }
  function parseTsvAtividade(txt) {
    var out = { geradoUtc: "", linhas: [] };
    String(txt || "").replace(/\r/g, "").split("\n").forEach(function (ln, i) {
      if (!ln) return;
      if (ln.charAt(0) === "#") { var m = /gerado_utc=(\S+)/.exec(ln); if (m) out.geradoUtc = m[1]; return; }
      var p = ln.split("\t");
      if (p[0] === "lead" && p[1] === "vend") return;
      if (p.length < 3) return;
      out.linhas.push({ lead: p[0], vend: p[1], s: p[2], d: p[3] || "", m: p[4] || "" });
    });
    return out;
  }
  /* lead -> { vendedor -> {s,d,m} }, só do que foi realmente trabalhado */
  function mapaAtividade(linhas) {
    var porLead = {};
    (linhas || []).forEach(function (x) {
      if (!x || !x.lead || !x.vend || !x.s || x.s === "novo") return;
      (porLead[x.lead] = porLead[x.lead] || {})[x.vend] = { s: x.s, d: String(x.d || "").slice(0, 10), m: String(x.m || "") };
    });
    return porLead;
  }

  /* ---------- o plano da madrugada ---------- */
  function filasAtivas(equipe) {
    var filas = [], cota = {};
    function entra(p) { filas.push(p.id); var c = parseInt(p.cota, 10); cota[p.id] = c > 0 ? c : COTA_PADRAO; }
    equipe.forEach(function (p) { if (!p.gestor && !p.inativo) entra(p); });
    equipe.forEach(function (p) { if (p.gestor && p.prospecta && !p.inativo) entra(p); });
    return { filas: filas, cota: cota };
  }
  /* o.equipe, o.leads, o.atividade (mapaAtividade; null = sem estado do banco), o.hoje */
  function planejar(o) {
    var fa = filasAtivas(o.equipe), filas = fa.filas, cota = fa.cota, ativo = {};
    if (!filas.length) throw new Error("nenhuma fila ativa em EQUIPE_FIXA");
    filas.forEach(function (v) { ativo[v] = 1; });
    var leads = o.leads.map(function (l) {
      var n = {}, k; for (k in l) n[k] = l[k];
      if (n.cap === undefined || n.cap === null) n.cap = capDoGancho(n.gancho);
      return n;
    });
    var res = { filas: filas, cota: cota, leads: leads, seguro: !o.atividade, corrigidos: 0, removidos: 0, movidos: 0,
                livresAntes: {}, livresDepois: {}, alvo: {}, novosPorFila: {}, novosTotal: 0, U: 0, C: 0, orfaos: 0,
                fupDia: diaDeFollowup(o.hoje), fupAntes: {}, fupDepois: {}, fupTotal: 0, fupRepassados: 0, baseCheia: false };
    filas.forEach(function (v) { res.novosPorFila[v] = 0; });
    /* Sem o estado do banco não dá para saber quem foi trabalhado: não mexe em nada. */
    if (!o.atividade) return res;
    var at = o.atividade;

    /* 1. o lead é de quem trabalhou nele (entre os ativos). A exceção é o follow-up
       repassado (her): fica com quem recebeu, a não ser que quem passou tenha marcado de
       novo depois do repasse - aí o lead volta para ele. */
    leads.forEach(function (l) {
      var regs = at[l.id];
      if (!regs || regs[l.vend]) { if (l.her) delete l.her; return; }
      if (l.her && l.her.v) {
        var prev = regs[l.her.v];
        if (!prev || (prev.s === l.her.s && prev.d === l.her.d)) return;
        if (ativo[l.her.v]) { l.vend = l.her.v; delete l.her; res.corrigidos++; return; }
        l.her = { v: l.her.v, s: prev.s, d: prev.d, m: prev.m || "" };
        return;
      }
      if (l.her) delete l.her;
      var melhor = null;
      Object.keys(regs).sort().forEach(function (v) {
        if (!ativo[v]) return;
        if (!melhor || regs[v].d > melhor.d) melhor = { v: v, d: regs[v].d };
      });
      if (melhor) { l.vend = melhor.v; res.corrigidos++; }
    });

    /* 2. sai do radar o que já foi encerrado há dias (o registro continua no banco).
       Quem ainda deve follow-up não sai nunca. */
    leads = leads.filter(function (l) {
      var regs = at[l.id]; if (!regs) return true;
      var r = estadoDe(l, at);
      if (!r) Object.keys(regs).forEach(function (v) { if (!r || regs[v].d > r.d) r = regs[v]; });
      if (r.s === "reuniao" || r.s === "proposta" || r.s === "fechado") return true;
      if (r.s === "contatado" || r.s === "fup1") return true;
      var limite = GUARDA[r.s] !== undefined ? GUARDA[r.s] : GUARDA.aberto;
      var dias = diasEntre(r.d, o.hoje);
      if (dias > limite) { res.removidos++; return false; }
      return true;
    });
    res.leads = leads;

    /* 3. quem ainda não recebeu a primeira mensagem, por fila */
    var livres = {}, orfaos = [];
    filas.forEach(function (v) { livres[v] = []; });
    leads.forEach(function (l) {
      if (at[l.id]) return;
      if (ativo[l.vend]) livres[l.vend].push(l); else orfaos.push(l);
    });
    var U = orfaos.length, C = 0;
    filas.forEach(function (v) { U += livres[v].length; C += cota[v]; res.livresAntes[v] = livres[v].length; });
    res.U = U; res.C = C; res.orfaos = orfaos.length;

    /* Leva cada fila ao seu alvo: quem tem de sobra cede uma amostra espalhada da fila
       (não só o fim dela), e quem tem de menos recebe em rodízio. Devolve o que faltou. */
    function repartir(porFila, soltos, alvoDe) {
      var doados = soltos.slice();
      filas.forEach(function (v) {
        var sobra = porFila[v].length - alvoDe[v];
        if (sobra <= 0) return;
        var ord = porFila[v].slice().sort(ordemFila), n = ord.length, tirar = {}, j, fica = [];
        for (j = 0; j < sobra; j++) tirar[Math.floor((j + 0.5) * n / sobra)] = 1;
        ord.forEach(function (l, i) { if (tirar[i]) doados.push(l); else fica.push(l); });
        porFila[v] = fica;
      });
      doados.sort(ordemFila);
      var falta = {}, receb = [], i = 0;
      filas.forEach(function (v) { falta[v] = Math.max(0, alvoDe[v] - porFila[v].length); if (falta[v] > 0) receb.push(v); });
      doados.forEach(function (l) {
        if (!receb.length) return;
        var t = 0;
        while (t < receb.length && falta[receb[i % receb.length]] <= 0) { i++; t++; }
        if (t >= receb.length) return;
        var v = receb[i % receb.length]; i++;
        if (l.vend !== v) { l.vend = v; res.movidos++; }
        porFila[v].push(l); falta[v]--;
      });
      return falta;
    }

    /* 4. quanto cada fila deve ter, e a repartição */
    var alvo = {}, falta = {};
    if (U >= C) {
      /* Base ainda cheia: sem lead novo. Reparte por igual e por estrato (dentro ou fora do
         porte, e prioridade), para todas as filas ficarem com a mesma mistura de leads. */
      var grupos = {}, acum = {};
      var estrato = function (l) { return ((+l.cap || 0) > CAP_MAX ? "1" : "0") + (PESO_PRIO[l.prio] !== undefined ? l.prio : "Z"); };
      var grupo = function (k) {
        if (!grupos[k]) { grupos[k] = { porFila: {}, soltos: [] }; filas.forEach(function (v) { grupos[k].porFila[v] = []; }); }
        return grupos[k];
      };
      filas.forEach(function (v) { acum[v] = 0; alvo[v] = 0; falta[v] = 0; livres[v].forEach(function (l) { grupo(estrato(l)).porFila[v].push(l); }); });
      orfaos.forEach(function (l) { grupo(estrato(l)).soltos.push(l); });
      Object.keys(grupos).sort().forEach(function (k) {
        var g = grupos[k], Us = g.soltos.length, alvoS = {}, soma = 0;
        filas.forEach(function (v) { Us += g.porFila[v].length; });
        filas.forEach(function (v) { alvoS[v] = Math.floor(Us * cota[v] / C); soma += alvoS[v]; });
        /* o que não divide certo vai para quem está com menos no total até aqui */
        filas.slice().sort(function (a, b) {
          return (acum[a] + alvoS[a]) / cota[a] - (acum[b] + alvoS[b]) / cota[b] ||
                 (g.porFila[b].length - g.porFila[a].length) || (a < b ? -1 : 1);
        }).slice(0, Us - soma).forEach(function (v) { alvoS[v]++; });
        filas.forEach(function (v) { acum[v] += alvoS[v]; alvo[v] += alvoS[v]; });
        repartir(g.porFila, g.soltos, alvoS);
      });
      filas.forEach(function (v) {
        livres[v] = [];
        Object.keys(grupos).forEach(function (k) { livres[v] = livres[v].concat(grupos[k].porFila[v]); });
      });
    } else {
      /* Base zerando: cada fila fecha a cota do dia; o que faltar vem de lead novo
         (menos em dia de follow-up, quando ninguém trabalha lead novo). */
      filas.forEach(function (v) { alvo[v] = cota[v]; });
      falta = repartir(livres, orfaos, alvo);
      if (!res.fupDia) res.novosTotal = C - U;
    }
    res.baseCheia = U >= C;
    res.alvo = alvo;
    filas.forEach(function (v) { res.livresDepois[v] = livres[v].length; res.novosPorFila[v] = res.novosTotal ? falta[v] : 0; });

    /* 5. Dia de follow-up (terça e quinta): os follow-ups vencidos são repartidos por igual.
       Quem tem mais do que a sua parte cede os mais atrasados; quem tem menos (ou nenhum)
       recebe. O lead leva o estado em que estava, para quem recebe mandar o follow-up certo. */
    var fups = {}, soltosF = [];
    filas.forEach(function (v) { fups[v] = []; });
    leads.forEach(function (l) {
      var r = estadoDe(l, at);
      if (!fupVencido(r, o.hoje)) return;
      var item = { l: l, r: r };
      if (ativo[l.vend]) fups[l.vend].push(item); else soltosF.push(item);
    });
    var T = soltosF.length;
    filas.forEach(function (v) { T += fups[v].length; res.fupAntes[v] = fups[v].length; });
    res.fupTotal = T;
    if (res.fupDia && T) {
      var alvoF = {}, somaF = 0, doadosF = soltosF.slice();
      filas.forEach(function (v) { alvoF[v] = Math.floor(T * cota[v] / C); somaF += alvoF[v]; });
      filas.slice().sort(function (a, b) { return (fups[b].length - alvoF[b]) - (fups[a].length - alvoF[a]) || (a < b ? -1 : 1); })
           .slice(0, T - somaF).forEach(function (v) { alvoF[v]++; });
      function maisAtrasado(a, b) { return a.r.d < b.r.d ? -1 : a.r.d > b.r.d ? 1 : (a.l.id < b.l.id ? -1 : 1); }
      filas.forEach(function (v) {
        var sobra = fups[v].length - alvoF[v];
        if (sobra <= 0) return;
        var ord = fups[v].slice().sort(maisAtrasado);
        doadosF = doadosF.concat(ord.slice(0, sobra));
        fups[v] = ord.slice(sobra);
      });
      doadosF.sort(maisAtrasado);
      var faltaF = {}, recebF = [], k = 0;
      filas.forEach(function (v) { faltaF[v] = Math.max(0, alvoF[v] - fups[v].length); if (faltaF[v] > 0) recebF.push(v); });
      doadosF.forEach(function (it) {
        if (!recebF.length) return;
        var t = 0;
        while (t < recebF.length && faltaF[recebF[k % recebF.length]] <= 0) { k++; t++; }
        if (t >= recebF.length) return;
        var v = recebF[k % recebF.length]; k++;
        var regs = at[it.l.id];
        /* de quem é o estado que vai junto: de quem marcou por último */
        var de = (regs && regs[it.l.vend]) ? it.l.vend : (it.l.her && it.l.her.v) || it.l.vend;
        it.l.her = { v: de, s: it.r.s, d: it.r.d, m: it.r.m || "" };
        it.l.vend = v;
        fups[v].push(it); faltaF[v]--; res.fupRepassados++;
      });
    }
    filas.forEach(function (v) { res.fupDepois[v] = fups[v].length; });
    return res;
  }

  /* Os leads novos de cada fila hoje, na ordem em que o radar mostra (para as planilhas).
     Em dia de follow-up não há lead novo: devolve as filas vazias. */
  function leadsDoDia(plano, atividade) {
    var out = {};
    plano.filas.forEach(function (v) {
      if (plano.fupDia) { out[v] = []; return; }
      out[v] = plano.leads.filter(function (l) { return l.vend === v && !atividade[l.id]; })
        .sort(ordemFila).slice(0, plano.cota[v]);
    });
    return out;
  }

  /* ---------- lead novo (só com a base zerada) ---------- */
  function parsePool(txt) {
    var linhas = txt.split("\n"), cab = linhas[0].replace(/\r$/, "").split("\t"), rows = [], i, f, j, o;
    if (cab.join("\t") !== COLS.join("\t")) throw new Error("cabecalho do pool inesperado (chave errada ou arquivo corrompido?)");
    for (i = 1; i < linhas.length; i++) {
      var ln = linhas[i].replace(/\r$/, ""); if (!ln) continue;
      f = ln.split("\t"); if (f.length < COLS.length) continue;
      o = {}; for (j = 0; j < COLS.length; j++) o[COLS[j]] = f[j];
      rows.push(o);
    }
    return rows;
  }
  /* o.pool, o.leads (os que já estão no radar), o.usados ({basico:1}), o.total, o.capMax */
  function selecionarNovos(o) {
    var capMax = o.capMax || CAP_MAX, log = [];
    var nomes = {}, fones = {}, usados = {}, k;
    for (k in (o.usados || {})) usados[k] = 1;
    o.leads.forEach(function (l) {
      nomes[norm(l.empresa)] = 1;
      var d = digitos(l.wa); if (d.length >= 10) fones[d] = 1;
      d = digitos(l.tel); if (d.length >= 10) fones[d] = 1;
      var c = digitos(l.cnpj); if (c.length >= 8) usados[c.slice(0, 8)] = 1;
    });
    var livresPool = o.pool.filter(function (c) { return !usados[c.basico] && !nomes[norm(c.empresa)] && !fones[c.phoneKey]; });
    var cand = livresPool.filter(function (c) { var v = parseFloat(c.capital); return !isNaN(v) && v <= capMax; });
    log.push("candidatos no pool=" + o.pool.length + ", ainda nao entregues=" + livresPool.length +
             ", com capital ate R$ " + capMax + "=" + cand.length);
    var total = o.total, alvo2 = Math.floor(total / 2), alvo1 = total - alvo2;
    function ordena(lst) {
      return lst.slice().sort(function (a, b) {
        if (a.prio !== b.prio) return a.prio < b.prio ? -1 : 1;
        var sa = parseInt(a.score, 10) || 0, sb = parseInt(b.score, 10) || 0;
        if (sa !== sb) return sb - sa;
        return parseFloat(a.rnd) - parseFloat(b.rnd);
      });
    }
    function grp(n) { return ordena(cand.filter(function (c) { return c.nicho === n; })); }
    var pegos = {};
    function tiraRodizio(grupos, quota) {
      var res = [], idx = grupos.map(function () { return 0; }), algum = true, g, c;
      while (res.length < quota && algum) {
        algum = false;
        for (g = 0; g < grupos.length; g++) {
          if (res.length >= quota) break;
          while (idx[g] < grupos[g].length && pegos[grupos[g][idx[g]].basico]) idx[g]++;
          if (idx[g] < grupos[g].length) { c = grupos[g][idx[g]]; idx[g]++; pegos[c.basico] = 1; res.push(c); algum = true; }
        }
      }
      return res;
    }
    /* bloco 2: o que já avançou com o time */
    var q2 = [[["Automotivo"], 0.415], [["Harmonização Facial", "Cirurgia Plástica", "Estética"], 0.20],
              [["Odontologia/Implante"], 0.138], [["Consórcio/Crédito"], 0.092], [["Advocacia"], 0.077], [["Imobiliário"], 0.077]];
    var b2 = [];
    q2.forEach(function (q) {
      var rot = q[0], quota = Math.round(alvo2 * q[1]);
      var grupo = ordena(cand.filter(function (c) { return rot.indexOf(c.nicho) >= 0; }));
      var got = tiraRodizio([grupo], quota);
      log.push(rot.join("+") + ": cota " + quota + " -> " + got.length);
      b2 = b2.concat(got);
    });
    var falta2 = alvo2 - b2.length;
    /* bloco 1: varejo e atacado, espalhados (nenhum rótulo acima de 15% do bloco) */
    var rot1 = {}; cand.forEach(function (c) { if (c.bloco === "1") rot1[c.nicho] = 1; });
    var rotulos1 = Object.keys(rot1).sort(), grupos1 = rotulos1.map(grp);
    var idx1 = grupos1.map(function () { return 0; }), cnt1 = grupos1.map(function () { return 0; });
    var need1 = alvo1 + falta2, cap1 = Math.ceil(alvo1 * 15 / 100), b1 = [], algum1 = true, g, c;
    while (b1.length < need1 && algum1) {
      algum1 = false;
      for (g = 0; g < grupos1.length; g++) {
        if (b1.length >= need1) break;
        if (cnt1[g] >= cap1) continue;
        while (idx1[g] < grupos1[g].length && pegos[grupos1[g][idx1[g]].basico]) idx1[g]++;
        if (idx1[g] < grupos1[g].length) { c = grupos1[g][idx1[g]]; idx1[g]++; pegos[c.basico] = 1; b1.push(c); cnt1[g]++; algum1 = true; }
      }
      if (!algum1 && b1.length < need1 && cap1 < need1) { cap1 += 10; algum1 = true; }
    }
    if (b1.length < need1) {
      var extra = tiraRodizio([grp("Automotivo")], need1 - b1.length);
      b2 = b2.concat(extra);
      log.push("faltou varejo/atacado, completado com Automotivo: " + extra.length);
    }
    rotulos1.forEach(function (n, gi) { if (cnt1[gi]) log.push(n + ": " + cnt1[gi]); });
    log.push("bloco1=" + b1.length + " bloco2=" + b2.length + " (bloco 2 faltou " + Math.max(0, falta2) + ", coberto com varejo/atacado)");
    function porPrio(l) {
      return l.filter(function (x) { return x.prio === "A"; }).concat(l.filter(function (x) { return x.prio === "B"; }),
             l.filter(function (x) { return x.prio !== "A" && x.prio !== "B"; }));
    }
    var p1 = porPrio(b1), p2 = porPrio(b2), fim = [], i1 = 0, i2 = 0, pos = 0;
    while (i1 < p1.length || i2 < p2.length) {
      if ((pos % 2 === 0 && i1 < p1.length) || i2 >= p2.length) fim.push(p1[i1++]); else fim.push(p2[i2++]);
      pos++;
    }
    if (fim.length !== total) log.push("ATENCAO: alvo era " + total + ", saiu " + fim.length + " (pool curto?)");
    return { escolhidos: fim, log: log, restamNoPorte: cand.length - fim.length };
  }
  /* Vira lead do radar, com id novo, repartido para fechar a cota de cada fila. */
  function montarNovos(o) {  /* o.escolhidos, o.plano, o.hoje, o.proximo, o.idsExistentes ({id:1}) */
    var filas = o.plano.filas, resta = {}, total = 0, slots = [], idx = diaDoAno(o.hoje) % filas.length, v, guarda = 0;
    filas.forEach(function (f) { resta[f] = o.plano.novosPorFila[f] || 0; total += resta[f]; });
    while (slots.length < total && guarda < total * filas.length + filas.length) {
      v = filas[idx % filas.length]; idx++; guarda++;
      if (resta[v] > 0) { slots.push(v); resta[v]--; }
    }
    var num = o.proximo, usadosIds = {}, novos = [];
    o.escolhidos.forEach(function (c, k) {
      if (k >= slots.length) return;
      var lid;
      do { lid = slug(c.empresa) + "-" + num; num++; } while (o.idsExistentes[lid] || usadosIds[lid]);
      usadosIds[lid] = 1;
      novos.push({ id: lid, empresa: c.empresa, nicho: c.nicho, cidade: c.cidade, ig: "", wa: c.wa, pageId: "",
                   gancho: c.gancho, prio: c.prio, oferta: c.oferta, vend: slots[k], loteData: o.hoje, fonte: "cnpj",
                   cnpj: c.cnpj, tel: c.tel, email: c.email, cap: Math.round(parseFloat(c.capital)) || 0 });
    });
    return { novos: novos, proximo: num };
  }

  /* Confere o plano antes de qualquer gravação. Devolve a lista de problemas (vazia = ok). */
  function conferir(antes, plano, novos, atividade) {
    var erros = [], ids = {}, antesIds = {}, finais = plano.leads.concat(novos || []);
    antes.forEach(function (l) { antesIds[l.id] = l; });
    finais.forEach(function (l) { if (ids[l.id]) erros.push("id repetido: " + l.id); ids[l.id] = 1; });
    if (plano.leads.length + plano.removidos !== antes.length) erros.push("contagem nao fecha: " + antes.length + " antes, " + plano.leads.length + " depois, " + plano.removidos + " removidos");
    if (atividade) {
      var ativo = {}; plano.filas.forEach(function (v) { ativo[v] = 1; });
      antes.forEach(function (l) { if (!atividade[l.id] && !ids[l.id]) erros.push("lead nao trabalhado sumiu: " + l.id); });
      plano.leads.forEach(function (l) {
        var a = antesIds[l.id]; if (!a) { erros.push("lead desconhecido: " + l.id); return; }
        var regs = atividade[l.id];
        /* lead trabalhado só muda de fila como follow-up repassado, levando o estado junto */
        var repasse = !!(regs && l.her && l.her.s && regs[l.her.v]);
        if (regs && l.vend !== a.vend && !regs[l.vend] && !repasse) erros.push("lead trabalhado mudou de fila sem levar o estado: " + l.id);
        if (repasse && !plano.fupDia && l.vend !== a.vend) erros.push("follow-up repassado fora do dia de follow-up: " + l.id);
        if (!regs && l.her) erros.push("lead nao trabalhado com estado de repasse: " + l.id);
        if (!regs && !ativo[l.vend] && plano.filas.length) erros.push("lead nao trabalhado ficou fora das filas ativas: " + l.id);
      });
      var porFila = {}, somaAntes = 0, somaDepois = 0;
      (novos || []).forEach(function (l) { porFila[l.vend] = (porFila[l.vend] || 0) + 1; });
      plano.filas.forEach(function (v) {
        var tem = plano.livresDepois[v];
        if (plano.baseCheia && tem !== plano.alvo[v]) erros.push("fila " + v + " ficou com " + tem + ", o alvo era " + plano.alvo[v]);
        if (tem + (porFila[v] || 0) > plano.alvo[v]) erros.push("fila " + v + " passou do alvo");
        somaAntes += plano.fupAntes[v] || 0; somaDepois += plano.fupDepois[v] || 0;
      });
      if (plano.fupDia && somaDepois !== plano.fupTotal) erros.push("follow-ups vencidos nao fecham: " + plano.fupTotal + " no total, " + somaDepois + " nas filas");
      if (!plano.fupDia && (novos || []).length === 0 && plano.fupRepassados) erros.push("repasse de follow-up fora do dia");
    }
    return erros.slice(0, 20);
  }

  var api = { CAP_MAX: CAP_MAX, COTA_PADRAO: COTA_PADRAO, COLS: COLS, norm: norm, slug: slug, extraiVar: extraiVar,
    montarHtml: montarHtml, semInvolucro: semInvolucro, linhasUteis: linhasUteis, hojeFortaleza: hojeFortaleza,
    diasEntre: diasEntre, capDoGancho: capDoGancho, ordemFila: ordemFila, lerAtividade: lerAtividade,
    bancoDoHtml: bancoDoHtml, tsvAtividade: tsvAtividade, parseTsvAtividade: parseTsvAtividade,
    mapaAtividade: mapaAtividade, filasAtivas: filasAtivas, planejar: planejar, leadsDoDia: leadsDoDia,
    diaDeFollowup: diaDeFollowup, estadoDe: estadoDe, fupVencido: fupVencido,
    parsePool: parsePool, selecionarNovos: selecionarNovos, montarNovos: montarNovos, conferir: conferir };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RadarFila = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
