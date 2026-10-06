/* Shoebox receipt parser: turns OCR text into {merchant, date, total, tax, category, kind, item}.
   Pure functions so they can be tested outside the browser. */
(function (root) {
  "use strict";

  const CATEGORIES = ["Groceries","Dining & coffee","Transport & gas","Shopping","Health & pharmacy","Home & utilities","Phone & internet","Subscriptions","Travel","Entertainment","Personal care","Gifts & donations","Education","Office & supplies","Software & tools","Professional services","Other"];
  const BUSINESS_CATS = new Set(["Office & supplies","Software & tools","Professional services"]);

  // [pattern, display name, category, kind?]
  const MERCHANTS = [
    [/costco/i,"Costco","Groceries"],[/superstore/i,"Real Canadian Superstore","Groceries"],[/safeway/i,"Safeway","Groceries"],
    [/sobeys/i,"Sobeys","Groceries"],[/save[\s-]?on[\s-]?foods/i,"Save-On-Foods","Groceries"],[/no\s?frills/i,"No Frills","Groceries"],
    [/fresh\s?co/i,"FreshCo","Groceries"],[/calgary\s+co-?op|\bco-?op\b/i,"Calgary Co-op","Groceries"],[/\bt\s?&\s?t\b/i,"T&T Supermarket","Groceries"],
    [/loblaw/i,"Loblaws","Groceries"],[/\biga\b/i,"IGA","Groceries"],[/whole\s?foods/i,"Whole Foods","Groceries"],[/african|afro|nigerian|global\s+foods/i,null,"Groceries"],
    [/shoppers\s*drug|shoppers/i,"Shoppers Drug Mart","Health & pharmacy"],[/rexall/i,"Rexall","Health & pharmacy"],[/pharmacy|pharmacie|drug\s?mart/i,null,"Health & pharmacy"],
    [/london\s+drugs/i,"London Drugs","Shopping"],[/wal[\s*-]?mart/i,"Walmart","Shopping"],[/dollarama/i,"Dollarama","Shopping"],
    [/winners/i,"Winners","Shopping"],[/home\s?sense/i,"HomeSense","Home & utilities"],[/marshalls/i,"Marshalls","Shopping"],
    [/best\s?buy/i,"Best Buy","Shopping"],[/amazon|amzn/i,"Amazon","Shopping"],[/indigo|chapters/i,"Indigo","Shopping"],
    [/lululemon/i,"Lululemon","Shopping"],[/\bh\s?&\s?m\b/i,"H&M","Shopping"],[/\bzara\b/i,"Zara","Shopping"],[/old\s?navy/i,"Old Navy","Shopping"],
    [/sport\s?chek/i,"Sport Chek","Shopping"],[/canadian\s+tire/i,"Canadian Tire","Shopping"],[/simons/i,"Simons","Shopping"],
    [/sephora/i,"Sephora","Personal care"],[/\bulta\b/i,"Ulta","Personal care"],[/salon|barber|\bspa\b|nails?\b|beauty/i,null,"Personal care"],
    [/tim\s?horton/i,"Tim Hortons","Dining & coffee"],[/starbucks/i,"Starbucks","Dining & coffee"],[/mcdonald/i,"McDonald's","Dining & coffee"],
    [/\ba\s?&\s?w\b/i,"A&W","Dining & coffee"],[/subway/i,"Subway","Dining & coffee"],[/second\s+cup/i,"Second Cup","Dining & coffee"],
    [/good\s+earth/i,"Good Earth","Dining & coffee"],[/phil\s*&\s*sebastian/i,"Phil & Sebastian","Dining & coffee"],[/\bearls\b/i,"Earls","Dining & coffee"],
    [/cactus\s+club/i,"Cactus Club","Dining & coffee"],[/boston\s+pizza/i,"Boston Pizza","Dining & coffee"],[/pizza\s?73/i,"Pizza 73","Dining & coffee"],
    [/uber\s*eats/i,"Uber Eats","Dining & coffee"],[/doordash/i,"DoorDash","Dining & coffee"],[/skip\s?the\s?dishes/i,"SkipTheDishes","Dining & coffee"],
    [/chipotle|wendy|burger\s+king|popeyes|kfc|dairy\s+queen|domino|pizza\s+hut|freshii|mary\s?brown|osmow|tacotime|denny/i,null,"Dining & coffee"],
    [/restaurant|bistro|cafe|café|coffee|kitchen|grill|eatery|pizzeria|sushi|ramen|pho\b|bakery|brewing|pub\b|tavern|diner|gratuity|server:/i,null,"Dining & coffee"],
    [/petro[\s-]?canada|petro-?can/i,"Petro-Canada","Transport & gas"],[/\bshell\b/i,"Shell","Transport & gas"],[/\besso\b/i,"Esso","Transport & gas"],
    [/husky/i,"Husky","Transport & gas"],[/chevron/i,"Chevron","Transport & gas"],[/\bmobil\b/i,"Mobil","Transport & gas"],[/fas\s?gas/i,"Fas Gas","Transport & gas"],
    [/calgary\s+transit|\bctrain\b/i,"Calgary Transit","Transport & gas"],[/\blyft\b/i,"Lyft","Transport & gas"],[/\buber\b/i,"Uber","Transport & gas"],
    [/park\s?plus|calgary\s+parking|impark|easypark|parking/i,null,"Transport & gas"],[/pump\s*#?\d|unleaded|regular\s+gas|diesel|litres|\bL\s*@/i,null,"Transport & gas"],
    [/home\s?depot/i,"Home Depot","Home & utilities"],[/\bikea\b/i,"IKEA","Home & utilities"],[/lowe'?s/i,"Lowe's","Home & utilities"],[/\brona\b/i,"RONA","Home & utilities"],
    [/enmax/i,"ENMAX","Home & utilities"],[/\batco\b/i,"ATCO","Home & utilities"],[/direct\s+energy/i,"Direct Energy","Home & utilities"],
    [/telus/i,"TELUS","Phone & internet"],[/rogers/i,"Rogers","Phone & internet"],[/\bbell\b/i,"Bell","Phone & internet"],[/\bshaw\b/i,"Shaw","Phone & internet"],
    [/koodo/i,"Koodo","Phone & internet"],[/\bfido\b/i,"Fido","Phone & internet"],[/freedom\s+mobile/i,"Freedom Mobile","Phone & internet"],[/public\s+mobile/i,"Public Mobile","Phone & internet"],
    [/netflix/i,"Netflix","Subscriptions"],[/spotify/i,"Spotify","Subscriptions"],[/apple\.com\/bill|itunes|icloud/i,"Apple","Subscriptions"],
    [/disney\s?\+|disneyplus/i,"Disney+","Subscriptions"],[/\bcrave\b/i,"Crave","Subscriptions"],[/youtube\s+premium/i,"YouTube Premium","Subscriptions"],
    [/air\s+canada/i,"Air Canada","Travel"],[/westjet/i,"WestJet","Travel"],[/flair\s+air/i,"Flair Airlines","Travel"],[/porter\s+air/i,"Porter Airlines","Travel"],
    [/marriott|hilton|hyatt|sheraton|holiday\s+inn|best\s+western|fairmont/i,null,"Travel"],[/airbnb/i,"Airbnb","Travel"],[/expedia/i,"Expedia","Travel"],
    [/cineplex/i,"Cineplex","Entertainment"],[/ticketmaster/i,"Ticketmaster","Entertainment"],
    [/staples/i,"Staples","Office & supplies","business"],[/canada\s+post|postes\s+canada/i,"Canada Post","Office & supplies","business"],
    [/\bups\b/i,"UPS","Office & supplies","business"],[/fedex/i,"FedEx","Office & supplies","business"],[/purolator/i,"Purolator","Office & supplies","business"],
    [/\bcanva\b/i,"Canva","Software & tools","business"],[/adobe/i,"Adobe","Software & tools","business"],[/google\s*\*?\s*(workspace|gsuite)/i,"Google Workspace","Software & tools","business"],
    [/microsoft/i,"Microsoft","Software & tools","business"],[/\bzoom\b/i,"Zoom","Software & tools","business"],[/\bnotion\b/i,"Notion","Software & tools","business"],
    [/squarespace/i,"Squarespace","Software & tools","business"],[/\bwix\b/i,"Wix","Software & tools","business"],[/shopify/i,"Shopify","Software & tools","business"],
    [/godaddy/i,"GoDaddy","Software & tools","business"],[/anthropic|openai|chatgpt/i,null,"Software & tools","business"],
  ];

  const ITEM_FOR = {"Groceries":"Groceries","Dining & coffee":"Meal","Transport & gas":"Gas","Shopping":"","Health & pharmacy":"Pharmacy","Home & utilities":"",
    "Phone & internet":"Phone bill","Subscriptions":"Subscription","Travel":"","Entertainment":"","Personal care":"","Gifts & donations":"Gift",
    "Education":"","Office & supplies":"Supplies","Software & tools":"Software","Professional services":"Service","Other":""};

  const MONTHS = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12,janv:1,fev:2,fevr:2,mars:3,avr:4,mai:5,juin:6,juil:7,aout:8,oct_:10,nov_:11,dec_:12};

  // Common OCR slips inside numbers: O->0, l/I->1, S->5 (only when touching digits).
  function fixDigits(s) {
    return s.replace(/(?<=[A-Za-z])0(?=[A-Za-z])/g, "O")
            .replace(/(?<=\d)[oO](?=\d)|(?<=\d[.,]\d?)[oO]|[oO](?=[.,]\d\d\b)/g, "0")
            .replace(/(?<=\d)[lI|](?=\d)/g, "1")
            .replace(/(?<=\d)[sS](?=\d)/g, "5");
  }

  // Money-looking numbers on a line: 12.34, 1,234.56, 12,34 (European), $ 12.34, 12.34-
  function amountsIn(line) {
    const out = [];
    const re = /(-?)\$?\s?(\d{1,3}(?:[,\s]\d{3})+|\d+)\s?([.,])\s?(\d{2})(?!\d)(-?)/g;
    let m;
    while ((m = re.exec(line))) {
      const whole = m[2].replace(/[,\s]/g, "");
      const n = parseFloat(whole + "." + m[4]);
      if (!isFinite(n) || n > 100000) continue;
      out.push((m[1] || m[5]) ? -n : n);
    }
    return out;
  }

  function pad(n) { return String(n).padStart(2, "0"); }
  function validDate(y, mo, d, today) {
    if (y < 100) y += 2000;
    if (!(y >= 2000 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
    const dt = new Date(y, mo - 1, d);
    if (dt.getMonth() !== mo - 1) return null;
    const t = today ? new Date(today + "T23:59:59") : new Date();
    if (dt - t > 2 * 864e5) return null;           // not in the future
    return `${y}-${pad(mo)}-${pad(d)}`;
  }
  function findDate(text, today) {
    const t = fixDigits(text);
    let m;
    // 2026-10-05, 2026/10/05
    const iso = /\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/g;
    while ((m = iso.exec(t))) { const v = validDate(+m[1], +m[2], +m[3], today); if (v) return v; }
    // Oct 05, 2026 / Oct 5 26 / 05 Oct 2026 / 05-OCT-26
    const mon = "(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\\.?";
    const r1 = new RegExp("\\b" + mon + "[\\s-]*(\\d{1,2})(?:st|nd|rd|th)?,?[\\s-]*(\\d{2,4})\\b", "gi");
    while ((m = r1.exec(t))) { const v = validDate(+m[3], MONTHS[m[1].toLowerCase().slice(0,3)], +m[2], today); if (v) return v; }
    const r2 = new RegExp("\\b(\\d{1,2})[\\s-]*" + mon + "[\\s-,]*(\\d{2,4})\\b", "gi");
    while ((m = r2.exec(t))) { const v = validDate(+m[3], MONTHS[m[2].toLowerCase().slice(0,3)], +m[1], today); if (v) return v; }
    // 10/05/2026, 05/10/26, 26/10/05
    const num = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/g;
    // 10/05/2026, 05/10/26, 26/10/05: when day and month could swap, take the reading closest to today.
    const ref = today ? new Date(today + "T12:00") : new Date();
    while ((m = num.exec(t))) {
      const a = +m[1], b = +m[2], c = +m[3];
      const opts = [validDate(c, a, b, today), validDate(c, b, a, today)];
      if (m[3].length === 2) opts.push(validDate(a, b, c, today));
      const ok = opts.filter(Boolean).sort((x, y) => Math.abs(new Date(x + "T12:00") - ref) - Math.abs(new Date(y + "T12:00") - ref));
      if (ok.length) return ok[0];
    }
    return null;
  }

  const TOTAL_RE = /\b(grand\s*total|total\s*due|amount\s*due|balance\s*due|total\s*amount|amount\s*paid|total|montant|net\s*total)\b/i;
  const NOT_TOTAL_RE = /sub\s*-?\s*total|subtot|total\s*(savings?|saved|items?|discounts?|qty|quantity|number|points|tax)|items?\s*sold|you\s+saved|tax\s*total/i;
  const TAX_RE = /\b(g\.?s\.?t|h\.?s\.?t|p\.?s\.?t|q\.?s\.?t|tps|tvq|tvh|tax(es)?|sales\s*tax)\b/i;
  const TAX_SKIP_RE = /reg(istration)?\b|#|\bno\.?\s*\d|bn\s*\d|\d{9}|exempt|before\s+tax|pre-?tax|tax\s*in|total\s*(?!tax)/i;
  const PAY_RE = /\b(visa|mastercard|master\s*card|m\/c|amex|debit|interac|credit|tend(?:er|ered)?|cash|charge|apple\s*pay|google\s*pay|paid|approved|purchase)\b/i;

  function findTotal(lines) {
    let best = null, how = "none";
    lines.forEach((l, i) => {
      if (!TOTAL_RE.test(l) || NOT_TOTAL_RE.test(l)) return;
      let a = amountsIn(l);
      if (!a.length && lines[i + 1]) a = amountsIn(lines[i + 1]);    // amount printed on the next line
      const v = a.filter(x => x > 0).pop();
      if (v != null && (best == null || v >= best)) { best = v; how = "total"; }
    });
    if (best == null) {
      lines.forEach(l => { if (PAY_RE.test(l)) { const v = amountsIn(l).filter(x => x > 0).pop(); if (v != null && (best == null || v > best)) { best = v; how = "payment"; } } });
    }
    if (best == null) {
      const all = lines.flatMap(amountsIn).filter(x => x > 0);
      if (all.length) { best = Math.max(...all); how = "largest"; }
    }
    return { total: best, how };
  }

  function findTax(lines, total) {
    let sum = 0, found = false, totalTax = null;
    for (const l of lines) {
      if (!TAX_RE.test(l)) continue;
      if (/total\s*tax|tax\s*total|taxes\s*total/i.test(l)) { const v = amountsIn(l).filter(x => x >= 0).pop(); if (v != null) totalTax = v; continue; }
      if (TAX_SKIP_RE.test(l)) continue;
      const v = amountsIn(l).filter(x => x >= 0).pop();
      if (v == null) continue;
      sum += v; found = true;
    }
    let tax = totalTax != null ? totalTax : (found ? Math.round(sum * 100) / 100 : null);
    if (tax != null && total != null && tax >= total * 0.5) tax = null;   // a "tax" bigger than half the bill is a misread
    return tax;
  }

  const MERCHANT_SKIP = /receipt|welcome|thank|store\s*#|store\s*no|tel\b|phone|fax|www\.|http|\.com|@|^\s*(\d|#)|cashier|register|trans(action)?|invoice|order|date|time|gst|hst|reg\b|street|\bst\.?\b|\bave\b|avenue|road|\brd\b|blvd|drive|\bdr\b|suite|unit|\bab\b|alberta|calgary|canada|t\d[a-z]\s?\d[a-z]\d/i;
  function titleCase(s) {
    return s.toLowerCase().replace(/(^|[\s&-])([a-z])/g, (m, p, c) => p + c.toUpperCase()).replace(/\bLtd\b/, "Ltd.").trim();
  }
  function findMerchantLine(lines) {
    for (const l of lines.slice(0, 8)) {
      const clean = l.replace(/[^A-Za-z0-9&'.\- ]/g, " ").replace(/\s+/g, " ").trim();
      const letters = (clean.match(/[A-Za-z]/g) || []).length;
      if (letters < 3 || letters / Math.max(clean.length, 1) < 0.6) continue;
      if (MERCHANT_SKIP.test(clean)) continue;
      return clean.length > 40 ? clean.slice(0, 40).trim() : clean;
    }
    return "";
  }

  /**
   * text: OCR output. opts.learned: {"merchant name lowercased": {category, kind}} from past receipts.
   * opts.today: "YYYY-MM-DD". opts.confidence: OCR mean confidence 0-100.
   */
  function parseReceipt(text, opts) {
    opts = opts || {};
    const today = opts.today || null;
    const raw = String(text || "");
    const lines = raw.split(/\r?\n/).map(l => fixDigits(l.trim())).filter(Boolean);
    const joined = lines.join("\n");

    // The store name is printed near the top, so the earliest match wins.
    let merchant = "", category = null, kind = null, named = null, generic = null;
    for (const [re, name, cat, k] of MERCHANTS) {
      const m = re.exec(joined);
      if (!m) continue;
      const hit = { at: m.index, name, cat, kind: k || null };
      if (name) { if (!named || hit.at < named.at) named = hit; }
      else if (!generic || hit.at < generic.at) generic = hit;
    }
    const pick = named || generic;
    if (pick) { category = pick.cat; kind = pick.kind; }
    if (named) merchant = named.name;
    if (!merchant) merchant = titleCase(findMerchantLine(lines));

    const learned = opts.learned || {};
    const key = merchant.toLowerCase();
    if (key && learned[key]) { category = learned[key].category || category; kind = learned[key].kind || kind; }

    const { total, how } = findTotal(lines);
    const tax = findTax(lines, total);
    const date = findDate(joined, today);
    if (!CATEGORIES.includes(category)) category = "Other";
    if (!kind) kind = BUSINESS_CATS.has(category) ? "business" : "personal";

    const weak = how !== "total" || !merchant || !date || (opts.confidence != null && opts.confidence < 55);
    return { merchant, date, total, tax, category, kind, item: ITEM_FOR[category] || "", confident: !weak, totalFrom: how };
  }

  const api = { parseReceipt, amountsIn, findDate, CATEGORIES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ShoeboxParse = api;
})(typeof window !== "undefined" ? window : globalThis);
