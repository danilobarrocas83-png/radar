#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
remessa_cnpj.py — gera a remessa diária do Radar Comercial a partir do pool de candidatos
(cadastro CNPJ da Receita Federal, já filtrado), sem tocar na Biblioteca de Anúncios.

Uso (na raiz do repositório):
  python3 scripts/remessa_cnpj.py --html <radar.html lido do artifact> --key <chave hex de 64 caracteres>
        [--data AAAA-MM-DD] [--por-fila 50] [--pool "pool/candidatos*.enc*"]
        [--usados pool/usados.txt] [--proximo-id pool/proximo_id.txt] [--saida saida]

Saídas (na pasta --saida):
  radar.html        documento completo (vai para o GitHub)
  radar_nuvem.html  sem o invólucro <!doctype>…<body> / </body></html> (vai para o artifact)
  leads_novos.json  só os leads novos de hoje
  resumo.txt        contagens

Códigos de saída: 0 = ok · 3 = já existe remessa com a data de hoje (nada foi gravado) · 1 = erro.
O script só imprime contagens: nunca nomes, telefones ou e-mails.
"""
import sys, os, re, json, hmac, hashlib, argparse, random, unicodedata
from datetime import datetime, timedelta, timezone

COLS = ["basico","cnpj","empresa","nicho","bloco","cidade","uf","wa","tel","email","gancho","oferta",
        "prio","score","dataInicio","porte","natureza","capital","rnd","key","phoneKey"]


def hoje_fortaleza():
    return (datetime.now(timezone.utc) - timedelta(hours=3)).strftime("%Y-%m-%d")


def decifrar(data, key):
    """HMAC-SHA256 em modo contador: arquivo = nonce(16) || texto XOR keystream."""
    nonce, ct = data[:16], data[16:]
    out = bytearray(len(ct))
    n = (len(ct) + 31) // 32
    for i in range(n):
        ks = hmac.new(key, nonce + i.to_bytes(8, "big"), hashlib.sha256).digest()
        s = i * 32
        blk = ct[s:s + 32]
        out[s:s + len(blk)] = bytes(a ^ b for a, b in zip(blk, ks))
    return bytes(out)


def norm(s):
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn").lower()
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def slug(s):
    t = re.sub(r"\s+", "-", norm(s)).strip("-")
    if len(t) > 40:
        t = t[:40].rstrip("-")
    return t or "empresa"


def extrai_var(html, nome):
    """Devolve (valor, inicio, fim) do JSON logo depois de `var NOME=` no HTML."""
    i = html.find("var " + nome + "=")
    if i < 0:
        raise SystemExit("nao achei var " + nome + " no HTML")
    j = html.find("=", i) + 1
    rest = html[j:]
    ws = len(rest) - len(rest.lstrip())
    obj, end = json.JSONDecoder().raw_decode(rest, ws)
    return obj, j + ws, j + end


def le_pool(padrao, key_hex):
    """Lê todos os arquivos que casam com o padrão (ex.: pool/candidatos*.tsv.enc), cada um com cabeçalho."""
    import glob
    arquivos = sorted(glob.glob(padrao))
    if not arquivos and os.path.exists(padrao):
        arquivos = [padrao]
    if not arquivos:
        raise SystemExit("nenhum arquivo de pool encontrado em " + padrao)
    rows = []
    for path in arquivos:
        with open(path, "rb") as f:
            raw = f.read()
        if path.endswith(".txt"):
            # cifrado e depois codificado em base64 (o artifact so serve arquivos de texto)
            import base64
            raw = base64.b64decode(b"".join(raw.split()))
        if path.endswith(".enc") or path.endswith(".enc.txt"):
            raw = decifrar(raw, bytes.fromhex(key_hex))
        try:
            txt = raw.decode("utf-8")
        except UnicodeDecodeError:
            raise SystemExit("nao consegui decifrar %s (chave errada ou arquivo corrompido?)" % path)
        linhas = txt.split("\n")
        header = linhas[0].rstrip("\r").split("\t")
        if header != COLS:
            raise SystemExit("cabecalho do pool inesperado em %s (chave errada ou arquivo corrompido?)" % path)
        for ln in linhas[1:]:
            ln = ln.rstrip("\r")
            if not ln:
                continue
            f = ln.split("\t")
            if len(f) < len(COLS):
                continue
            rows.append(dict(zip(COLS, f)))
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--html", required=True)
    ap.add_argument("--key", required=True)
    ap.add_argument("--data", default=None)
    ap.add_argument("--por-fila", type=int, default=50)
    ap.add_argument("--pool", default="pool/candidatos*.enc*")
    ap.add_argument("--usados", default="pool/usados.txt")
    ap.add_argument("--proximo-id", default="pool/proximo_id.txt")
    ap.add_argument("--saida", default="saida")
    a = ap.parse_args()

    hoje = a.data or hoje_fortaleza()
    with open(a.html, "r", encoding="utf-8") as f:
        html = f.read()
    if html.count("<!doctype html>") != 1 or html.count("</body></html>") != 1:
        raise SystemExit("HTML sem o involucro esperado (esperava 1 <!doctype html> e 1 </body></html>)")

    equipe, _, _ = extrai_var(html, "EQUIPE_FIXA")
    leads, l_ini, l_fim = extrai_var(html, "LEADS_EMBUTIDOS")
    remanejo, _, _ = extrai_var(html, "REMANEJO")

    filas = [p["id"] for p in equipe if not p.get("gestor") and not p.get("inativo")]
    filas += [p["id"] for p in equipe if p.get("gestor") and p.get("prospecta")]
    if not filas:
        raise SystemExit("nenhuma fila ativa em EQUIPE_FIXA")

    datas = sorted(set(str(l.get("loteData", "")) for l in leads if l.get("loteData")))
    ja_tem_hoje = hoje in datas

    ids_exist = set(str(l["id"]) for l in leads) | set(remanejo.keys())
    nomes_exist = set(norm(str(l.get("empresa", ""))) for l in leads)
    fones_exist = set()
    usados = set()
    for l in leads:
        d = re.sub(r"\D", "", str(l.get("wa", "") or ""))
        if len(d) >= 10:
            fones_exist.add(d)
        d = re.sub(r"\D", "", str(l.get("tel", "") or ""))
        if len(d) >= 10:
            fones_exist.add(d)
        c = re.sub(r"\D", "", str(l.get("cnpj", "") or ""))
        if len(c) >= 8:
            usados.add(c[:8])
    if os.path.exists(a.usados):
        with open(a.usados, "r", encoding="utf-8") as f:
            for ln in f:
                t = ln.strip()
                if t:
                    usados.add(t)
    maior_num = 0
    for i in ids_exist:
        m = re.search(r"-(\d+)$", i)
        if m:
            maior_num = max(maior_num, int(m.group(1)))
    proximo = maior_num + 1
    if os.path.exists(a.proximo_id):
        with open(a.proximo_id, "r", encoding="utf-8") as f:
            t = f.read().strip()
            if t.isdigit():
                proximo = max(proximo, int(t))

    pool = le_pool(a.pool, a.key)
    cand = [c for c in pool if c["basico"] not in usados
            and norm(c["empresa"]) not in nomes_exist
            and c["phoneKey"] not in fones_exist]

    total = len(filas) * a.por_fila
    alvo2 = total // 2
    alvo1 = total - alvo2

    def ordena(lst):
        return sorted(lst, key=lambda c: (c["prio"], -int(c["score"]), float(c["rnd"])))

    def grp(n):
        return ordena([c for c in cand if c["nicho"] == n])

    usados_sel = set()

    def take_rr(groups, quota):
        res = []
        idx = [0] * len(groups)
        any_ = True
        while len(res) < quota and any_:
            any_ = False
            for g in range(len(groups)):
                if len(res) >= quota:
                    break
                while idx[g] < len(groups[g]) and groups[g][idx[g]]["basico"] in usados_sel:
                    idx[g] += 1
                if idx[g] < len(groups[g]):
                    c = groups[g][idx[g]]
                    idx[g] += 1
                    usados_sel.add(c["basico"])
                    res.append(c)
                    any_ = True
        return res

    log = []
    q2 = [(["Automotivo"], round(alvo2 * 0.415)),
          (["Harmonização Facial", "Cirurgia Plástica", "Estética"], round(alvo2 * 0.20)),
          (["Odontologia/Implante"], round(alvo2 * 0.138)),
          (["Consórcio/Crédito"], round(alvo2 * 0.092)),
          (["Advocacia"], round(alvo2 * 0.077)),
          (["Imobiliário"], round(alvo2 * 0.077))]
    taken2 = []
    for labels, quota in q2:
        if len(labels) > 1:
            groups = [ordena([c for c in cand if c["nicho"] in labels])]
        else:
            groups = [grp(labels[0])]
        got = take_rr(groups, quota)
        log.append("%s: cota %d -> %d" % ("+".join(labels), quota, len(got)))
        taken2 += got
    falta2 = alvo2 - len(taken2)

    labels1 = sorted(set(c["nicho"] for c in cand if c["bloco"] == "1"))
    groups1 = [grp(n) for n in labels1]
    idx1 = [0] * len(groups1)
    cnt1 = [0] * len(groups1)
    need1 = alvo1 + falta2
    cap1 = -(-alvo1 * 15 // 100)
    taken1 = []
    any1 = True
    while len(taken1) < need1 and any1:
        any1 = False
        for g in range(len(groups1)):
            if len(taken1) >= need1:
                break
            if cnt1[g] >= cap1:
                continue
            while idx1[g] < len(groups1[g]) and groups1[g][idx1[g]]["basico"] in usados_sel:
                idx1[g] += 1
            if idx1[g] < len(groups1[g]):
                c = groups1[g][idx1[g]]
                idx1[g] += 1
                usados_sel.add(c["basico"])
                taken1.append(c)
                cnt1[g] += 1
                any1 = True
        if not any1 and len(taken1) < need1 and cap1 < need1:
            cap1 += 10
            any1 = True
    if len(taken1) < need1:
        extra = take_rr([grp("Automotivo")], need1 - len(taken1))
        taken2 += extra
        log.append("faltou varejo/atacado, completado com Automotivo: %d" % len(extra))
    for g, n in enumerate(labels1):
        if cnt1[g]:
            log.append("%s: %d" % (n, cnt1[g]))
    log.append("bloco1=%d bloco2=%d (bloco 2 faltou %d, coberto com varejo/atacado)" % (len(taken1), len(taken2), falta2))

    def by_prio(l):
        return [c for c in l if c["prio"] == "A"] + [c for c in l if c["prio"] == "B"] + [c for c in l if c["prio"] == "C"]

    b1, b2 = by_prio(taken1), by_prio(taken2)
    final = []
    i1 = i2 = pos = 0
    while i1 < len(b1) or i2 < len(b2):
        if (pos % 2 == 0 and i1 < len(b1)) or i2 >= len(b2):
            final.append(b1[i1]); i1 += 1
        else:
            final.append(b2[i2]); i2 += 1
        pos += 1
    if len(final) != total:
        log.append("ATENCAO: alvo era %d, saiu %d (pool curto?)" % (total, len(final)))

    dia_ano = datetime.strptime(hoje, "%Y-%m-%d").timetuple().tm_yday
    start = dia_ano % len(filas)
    out_ids = set()
    novos = []
    num = proximo
    por_fila, por_prio, por_nicho, com_wa = {}, {}, {}, 0
    for k, c in enumerate(final):
        vend = filas[(start + k) % len(filas)]
        while True:
            lid = "%s-%d" % (slug(c["empresa"]), num)
            num += 1
            if lid not in ids_exist and lid not in out_ids:
                break
        out_ids.add(lid)
        novos.append({"id": lid, "empresa": c["empresa"], "nicho": c["nicho"], "cidade": c["cidade"],
                      "ig": "", "wa": c["wa"], "pageId": "", "gancho": c["gancho"], "prio": c["prio"],
                      "oferta": c["oferta"], "vend": vend, "loteData": hoje, "fonte": "cnpj",
                      "cnpj": c["cnpj"], "tel": c["tel"], "email": c["email"]})
        por_fila[vend] = por_fila.get(vend, 0) + 1
        por_prio[c["prio"]] = por_prio.get(c["prio"], 0) + 1
        por_nicho[c["nicho"]] = por_nicho.get(c["nicho"], 0) + 1
        if c["wa"]:
            com_wa += 1

    manter_datas = datas[-2:]
    mantidos = [l for l in leads if str(l.get("loteData", "")) in manter_datas]
    lista = mantidos + novos
    arr = json.dumps(lista, ensure_ascii=False, separators=(",", ":"))
    html_novo = html[:l_ini] + arr + html[l_fim:]
    b = html_novo.find("<body>")
    e = html_novo.rfind("</body>")
    artifact = html_novo[b + len("<body>"):e]

    resumo = []
    resumo.append("data=%s filas=%d por_fila=%d" % (hoje, len(filas), a.por_fila))
    resumo.append("candidatos no pool=%d, apos dedupe=%d" % (len(pool), len(cand)))
    resumo += log
    resumo.append("novos=%d comWhatsApp=%d ids %d..%d" % (len(novos), com_wa, proximo, num - 1))
    resumo.append("por fila: " + " ".join("%s=%d" % kv for kv in sorted(por_fila.items())))
    resumo.append("por prio: " + " ".join("%s=%d" % kv for kv in sorted(por_prio.items())))
    resumo.append("por nicho: " + " | ".join("%s=%d" % kv for kv in sorted(por_nicho.items(), key=lambda x: -x[1])))
    resumo.append("lotes mantidos=%s descartados=%s" % (manter_datas, [d for d in datas if d not in manter_datas]))
    resumo.append("total embutido=%d" % len(lista))
    print("\n".join(resumo))

    if ja_tem_hoje:
        print("JA EXISTE remessa com loteData=%s no HTML: nada foi gravado (saida 3)." % hoje)
        sys.exit(3)

    os.makedirs(a.saida, exist_ok=True)
    with open(os.path.join(a.saida, "radar.html"), "w", encoding="utf-8", newline="\n") as f:
        f.write(html_novo)
    with open(os.path.join(a.saida, "radar_nuvem.html"), "w", encoding="utf-8", newline="\n") as f:
        f.write(artifact)
    with open(os.path.join(a.saida, "leads_novos.json"), "w", encoding="utf-8") as f:
        json.dump(novos, f, ensure_ascii=False, indent=1)
    with open(os.path.join(a.saida, "resumo.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(resumo) + "\n")
    with open(a.usados, "a", encoding="utf-8") as f:
        for c in final:
            f.write(c["basico"] + "\n")
    with open(a.proximo_id, "w", encoding="utf-8") as f:
        f.write(str(num) + "\n")
    print("OK: arquivos em %s; usados e proximo_id atualizados." % a.saida)


if __name__ == "__main__":
    main()
