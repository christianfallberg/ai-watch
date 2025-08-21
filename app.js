(async function () {
  const res = await fetch('./data.json', { cache: 'no-store' });
  const data = await res.json();

  document.getElementById('last-updated').textContent =
    `Uppdaterad: ${new Date(data.generated_at).toLocaleString()}`;

  // Alerts
  const alertsUl = document.getElementById('alerts-list');
  (data.alerts || []).slice(0, 25).forEach(it => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = it.link; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = it.title;
    li.appendChild(a);
    const meta = document.createElement('small');
    meta.style.display='block';
    meta.textContent = `${new Date(it.published).toLocaleDateString()} — ${it.source || ''}`;
    li.appendChild(meta);
    alertsUl.appendChild(li);
  });

  // GSC
  const sumUl = document.getElementById('gsc-summary');
  const s = data.gsc?.summary || {};
  for (const [k,v] of Object.entries(s)) {
    const li=document.createElement('li'); li.textContent=`${k}: ${v}`;
    sumUl.appendChild(li);
  }
  const qOl = document.getElementById('gsc-queries');
  (data.gsc?.topQueries || []).slice(0,10).forEach(row=>{
    const li=document.createElement('li');
    li.textContent=`${row.query} — ${row.clicks} klick, ${row.impressions} visn., CTR ${(row.ctr*100).toFixed(1)}%`;
    qOl.appendChild(li);
  });
  const pOl = document.getElementById('gsc-pages');
  (data.gsc?.topPages || []).slice(0,10).forEach(row=>{
    const li=document.createElement('li');
    const a=document.createElement('a'); a.href=row.page; a.textContent=row.page; a.target='_blank';
    li.appendChild(a);
    const s=document.createElement('small');
    s.style.display='block';
    s.textContent=`${row.clicks} klick, ${row.impressions} visn., CTR ${(row.ctr*100).toFixed(1)}%`;
    li.appendChild(s);
    pOl.appendChild(li);
  });

  // Bots
  const botsTbody = document.querySelector('#bots-table tbody');
  (data.bots || []).forEach(b=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${b.name}</td><td>${b.hits}</td><td>${b.last_seen ? new Date(b.last_seen).toLocaleString() : '-'}</td>`;
    botsTbody.appendChild(tr);
  });
})();
