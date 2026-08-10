# Wix Studio "Packing" scan page

The QR printed from the Packing Details module encodes:

```
https://www.candorfoods.in/packing?t=<encrypted-batch-token>
```

When scanned, this Wix page reads `t`, calls the backend's **public** scan
endpoint (no auth), and renders the batch's block details.

Backend endpoint (already built):
`GET https://<YOUR-HTTPS-BACKEND>/api/v1/packing-details/public/scan?t=<token>`
→ `{ batch_code, count, records: [{ packing_id, article_name, details, created_at }] }`

> ⚠️ The backend **must** be reachable over **HTTPS** from Wix. A Wix (HTTPS)
> page cannot call `http://65.0.86.156`. Point `API_BASE` below at a public
> HTTPS origin (e.g. `https://api.candorfoods.in`). CORS is already open on the
> backend (`allow_origins=["*"]`).

## Setup

1. In Wix Studio, create/confirm a page whose slug is `packing` (so
   `https://www.candorfoods.in/packing` resolves), and turn on **Dev Mode (Velo)**.
2. Add an **Embed → Embed HTML / iframe** element to the page. Note its ID
   (default `#html1`) and paste the **HTML component** block below into it.
3. Open the page **Code** panel and paste the **Page code** block below. Set
   `API_BASE` to your public HTTPS backend origin.
4. **Publish** the site.

## Page code (Velo — page Code panel)

```js
import wixLocation from 'wix-location-frontend';

// >>> SET THIS to your public HTTPS backend origin (NOT http://65.0.86.156) <<<
const API_BASE = 'https://mmvxmfvhmq.ap-south-1.awsapprunner.com';

$w.onReady(async () => {
  const token = wixLocation.query.t;
  const html = $w('#html1'); // <-- match your Embed HTML element's ID

  if (!token) {
    html.postMessage({ error: 'No packing code in this link.' });
    return;
  }
  try {
    const res = await fetch(
      `${API_BASE}/api/v1/packing-details/public/scan?t=${encodeURIComponent(token)}`
    );
    if (!res.ok) {
      html.postMessage({ error: 'Could not load packing details.' });
      return;
    }
    html.postMessage(await res.json());
  } catch (e) {
    html.postMessage({ error: 'Error loading packing details.' });
  }
});
```

## HTML component (paste into the Embed HTML element)

```html
<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
  body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#16191f;margin:0;padding:16px}
  .batch{font-size:20px;font-weight:700}
  .art{color:#414d5c;margin:2px 0 14px}
  .rec{border:1px solid #d5dbdb;border-radius:8px;padding:12px;margin-bottom:12px}
  table{width:100%;border-collapse:collapse}
  td{padding:6px 8px;border-bottom:1px solid #eaeded;font-size:14px;vertical-align:top}
  td.k{color:#687078;width:40%;font-weight:600}
  .err{color:#b00020;font-size:14px}
</style></head><body>
<div id="root">Loading…</div>
<script>
  function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
  function fmt(v){return (v && typeof v === 'object') ? JSON.stringify(v) : String(v);}
  function render(data){
    var root = document.getElementById('root');
    if(!data || data.error){ root.innerHTML = '<div class="err">'+esc((data && data.error) || 'No data')+'</div>'; return; }
    var html = '<div class="batch">'+esc(data.batch_code)+'</div>';
    (data.records || []).forEach(function(rec){
      html += '<div class="rec"><div class="art">'+esc(rec.article_name || '')+'</div><table>';
      var d = rec.details || {};
      Object.keys(d).forEach(function(k){
        html += '<tr><td class="k">'+esc(k)+'</td><td>'+esc(fmt(d[k]))+'</td></tr>';
      });
      if(!Object.keys(d).length){ html += '<tr><td colspan="2">No block details.</td></tr>'; }
      html += '</table></div>';
    });
    root.innerHTML = html;
  }
  window.onmessage = function(e){ render(e.data); };
</script>
</body></html>
```
