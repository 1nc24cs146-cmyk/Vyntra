import { titleFromPrompt } from "./templates";

export interface MajorTemplateFile {
  content: string;
  path: string;
}

export interface MajorTemplateApp {
  description: string;
  files: MajorTemplateFile[];
  title: string;
  type: string;
}

const MAJOR_WORDS = [
  "major project",
  "full-stack",
  "full stack",
  "ecommerce",
  "e-commerce",
  "online shop",
  "online store",
  "shopping website",
  "blog",
  "cms",
  "dashboard",
  "admin panel",
  "booking",
  "hotel",
  "restaurant",
  "inventory",
  "crm",
  "social media",
  "chat app",
  "learning management",
  "library management",
  "hospital",
  "school management"
];

export function isMajorRequest(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return MAJOR_WORDS.some((w) => lower.includes(w));
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function readme(title: string, description: string, run: string): string {
  return "# " + title + "\n\n" + description + "\n\n## Run it\n\n" + run + "\n\n## What is inside\n\nA complete, working project — not a skeleton. Open the files, change the data and text, and keep building from there.\n";
}

const CSS =
  "body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0f172a;color:#e2e8f0} " +
  "header{padding:28px 20px;background:linear-gradient(135deg,#2563eb,#7c3aed)} header h1{margin:0} " +
  "main{max-width:1000px;margin:0 auto;padding:24px 16px} .card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:18px;margin:14px 0} " +
  "input,textarea,select{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;margin:6px 0} " +
  "button{background:#2563eb;color:#fff;border:0;border-radius:8px;padding:9px 14px;cursor:pointer;margin:4px 4px 4px 0} button.secondary{background:#334155} " +
  ".grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px} .price{font-weight:700;color:#93c5fd} a{color:#93c5fd} " +
  ".bar{height:10px;background:#334155;border-radius:6px;overflow:hidden} .bar > div{height:100%;background:#22c55e}";

function shopApp(title: string): MajorTemplateApp {
  const index =
    "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<title>" +
    esc(title) +
    "</title>\n<link rel=\"stylesheet\" href=\"style.css\">\n</head>\n<body>\n<header><h1>" +
    esc(title) +
    "</h1><p>Search, filter, add to cart and check out — all working in your browser.</p></header>\n<main>\n<div class=\"card\"><input id=\"search\" placeholder=\"Search products...\" oninput=\"renderShop()\">\n<div><button onclick=\"setCategory('All')\">All</button><button onclick=\"setCategory('Electronics')\">Electronics</button><button onclick=\"setCategory('Fashion')\">Fashion</button><button onclick=\"setCategory('Home')\">Home</button></div></div>\n<div class=\"grid\" id=\"products\"></div>\n<div class=\"card\"><h2>Your cart (<span id=\"cartCount\">0</span>)</h2><div id=\"cart\"></div><p id=\"cartTotal\"></p><button onclick=\"checkout()\">Checkout</button><p id=\"orderMsg\"></p></div>\n</main>\n<script src=\"app.js\"></script>\n</body>\n</html>\n";
  const appJs = [
    "var products = [",
    "  {id: 1, name: 'Wireless Headphones', price: 2499, category: 'Electronics', desc: 'Noise-isolating headphones with 30-hour battery.'},",
    "  {id: 2, name: 'Smart Watch', price: 3499, category: 'Electronics', desc: 'Steps, heart rate and notifications on your wrist.'},",
    "  {id: 3, name: 'Bluetooth Speaker', price: 1799, category: 'Electronics', desc: 'Room-filling sound in a portable speaker.'},",
    "  {id: 4, name: 'Running Shoes', price: 2999, category: 'Fashion', desc: 'Light, cushioned shoes for daily runs.'},",
    "  {id: 5, name: 'Denim Jacket', price: 2199, category: 'Fashion', desc: 'A classic jacket that goes with everything.'},",
    "  {id: 6, name: 'Sunglasses', price: 1299, category: 'Fashion', desc: 'UV protection with a clean, modern frame.'},",
    "  {id: 7, name: 'Desk Lamp', price: 899, category: 'Home', desc: 'Warm, adjustable light for work and reading.'},",
    "  {id: 8, name: 'Ceramic Mug Set', price: 799, category: 'Home', desc: 'Four mugs for coffee, tea and everything else.'},",
    "  {id: 9, name: 'Laptop Stand', price: 1499, category: 'Electronics', desc: 'Better posture for long work sessions.'},",
    "  {id: 10, name: 'Backpack', price: 1899, category: 'Fashion', desc: 'Padded laptop sleeve and water-resistant fabric.'},",
    "  {id: 11, name: 'Plant Pot Set', price: 699, category: 'Home', desc: 'Three pots to green up a desk or balcony.'},",
    "  {id: 12, name: 'Mechanical Keyboard', price: 3999, category: 'Electronics', desc: 'Tactile keys for typing and coding.'}",
    "];",
    "var category = 'All';",
    "var cart = JSON.parse(localStorage.getItem('shop-cart') || '{}');",
    "function setCategory(c){ category = c; renderShop(); }",
    "function saveCart(){ localStorage.setItem('shop-cart', JSON.stringify(cart)); renderCart(); }",
    "function addToCart(id){ cart[id] = (cart[id] || 0) + 1; saveCart(); }",
    "function changeQty(id, d){ cart[id] = (cart[id] || 0) + d; if(cart[id] <= 0) delete cart[id]; saveCart(); }",
    "function renderShop(){ var q = (document.getElementById('search').value || '').toLowerCase(); var list = products.filter(function(p){ return (category === 'All' || p.category === category) && p.name.toLowerCase().includes(q); }); var html = ''; list.forEach(function(p){ html += '<div class=\"card\"><h3>' + p.name + '</h3><p>' + p.desc + '</p><p class=\"price\">Rs ' + p.price + ' - ' + p.category + '</p><button onclick=\"addToCart(' + p.id + ')\">Add to cart</button></div>'; }); document.getElementById('products').innerHTML = html || '<p>No products match that search.</p>'; renderCart(); }",
    "function renderCart(){ var total = 0; var count = 0; var html = ''; Object.keys(cart).forEach(function(id){ var p = products.find(function(x){ return x.id === Number(id); }); if(!p) return; var qty = cart[id]; total += p.price * qty; count += qty; html += '<p>' + p.name + ' x ' + qty + ' = Rs ' + (p.price * qty) + ' <button onclick=\"changeQty(' + p.id + ',1)\">+</button> <button class=\"secondary\" onclick=\"changeQty(' + p.id + ',-1)\">-</button></p>'; }); document.getElementById('cart').innerHTML = html || '<p>Your cart is empty.</p>'; document.getElementById('cartTotal').textContent = 'Total: Rs ' + total; document.getElementById('cartCount').textContent = String(count); }",
    "function checkout(){ if(Object.keys(cart).length === 0){ document.getElementById('orderMsg').textContent = 'Your cart is empty.'; return; } cart = {}; saveCart(); document.getElementById('orderMsg').textContent = 'Order placed! Thank you — this demo checkout does not take real payment.'; }",
    "renderShop();"
  ].join("\n");
  return {
    description: "A complete multi-file shop: 12 products, search, category filters, a working cart saved in the browser, and checkout.",
    files: [
      { content: index, path: "index.html" },
      { content: CSS + "\n", path: "style.css" },
      { content: appJs + "\n", path: "app.js" },
      { content: readme(title, "A complete multi-file shop: 12 products, search, category filters, a working cart saved in the browser, and checkout.", "Open `index.html` in a browser, or serve the folder with `python3 -m http.server 8000`."), path: "README.md" }
    ],
    title,
    type: "shop"
  };
}

function blogApp(title: string): MajorTemplateApp {
  const index =
    "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<title>" +
    esc(title) +
    "</title>\n<link rel=\"stylesheet\" href=\"style.css\">\n</head>\n<body>\n<header><h1>" +
    esc(title) +
    "</h1><p>Read posts, search them, and publish your own — saved in your browser.</p></header>\n<main>\n<div class=\"card\"><input id=\"search\" placeholder=\"Search posts...\" oninput=\"renderBlog()\"></div>\n<div id=\"posts\"></div>\n<div class=\"card\"><h2>Write a post</h2><input id=\"newTitle\" placeholder=\"Post title\"><textarea id=\"newBody\" rows=\"5\" placeholder=\"Write your post...\"></textarea><button onclick=\"publishPost()\">Publish</button><p id=\"publishMsg\"></p></div>\n</main>\n<script src=\"app.js\"></script>\n</body>\n</html>\n";
  const appJs = [
    "var seed = [",
    "  {title: 'How I started building for the web', category: 'Building', body: 'Every project starts the same way: one small page that works, then one feature at a time. Ship the small thing first.'},",
    "  {title: 'Why local-first tools matter', category: 'Tools', body: 'When your code and your models stay on your machine, you keep control of your work and your privacy.'},",
    "  {title: 'A simple habit for better code', category: 'Practice', body: 'Write the test or the example first. If you cannot describe what good looks like, the code will not know either.'},",
    "  {title: 'Design is not decoration', category: 'Design', body: 'Good design is a page that is easy to read, easy to use, and fast on a phone. Start there.'},",
    "  {title: 'Learning in public', category: 'Learning', body: 'Share what you build, even when it is small. Small, finished work teaches more than big, unfinished plans.'}",
    "];",
    "var mine = JSON.parse(localStorage.getItem('blog-posts') || '[]');",
    "var posts = mine.concat(seed);",
    "function renderBlog(){ var q = (document.getElementById('search').value || '').toLowerCase(); var html = ''; posts.forEach(function(p, i){ if(p.title.toLowerCase().includes(q) || p.body.toLowerCase().includes(q)){ html += '<div class=\"card\"><h3>' + p.title + '</h3><p><i>' + p.category + '</i></p><p>' + p.body + '</p></div>'; } }); document.getElementById('posts').innerHTML = html || '<p>No posts match that search.</p>'; }",
    "function publishPost(){ var t = document.getElementById('newTitle').value.trim(); var b = document.getElementById('newBody').value.trim(); if(!t || !b){ document.getElementById('publishMsg').textContent = 'Add a title and some text first.'; return; } var post = {title: t, category: 'My post', body: b}; mine.unshift(post); posts.unshift(post); localStorage.setItem('blog-posts', JSON.stringify(mine)); document.getElementById('newTitle').value = ''; document.getElementById('newBody').value = ''; document.getElementById('publishMsg').textContent = 'Published!'; renderBlog(); }",
    "renderBlog();"
  ].join("\n");
  return {
    description: "A complete multi-file blog/CMS: seeded posts, search, reading view and publishing, with your posts saved in the browser.",
    files: [
      { content: index, path: "index.html" },
      { content: CSS + "\n", path: "style.css" },
      { content: appJs + "\n", path: "app.js" },
      { content: readme(title, "A complete multi-file blog/CMS: seeded posts, search and publishing, with your posts saved in the browser.", "Open `index.html` in a browser, or serve the folder with `python3 -m http.server 8000`."), path: "README.md" }
    ],
    title,
    type: "blog"
  };
}

function dashboardApp(title: string): MajorTemplateApp {
  const index =
    "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<title>" +
    esc(title) +
    "</title>\n<link rel=\"stylesheet\" href=\"style.css\">\n</head>\n<body>\n<header><h1>" +
    esc(title) +
    "</h1><p>Projects, tasks and progress — all working, all saved in your browser.</p></header>\n<main>\n<div class=\"grid\" id=\"stats\"></div>\n<div id=\"projects\"></div>\n<div class=\"card\"><h2>Add a task</h2><input id=\"taskText\" placeholder=\"Task name\"><select id=\"taskProject\"></select><button onclick=\"addTask()\">Add task</button></div>\n</main>\n<script src=\"app.js\"></script>\n</body>\n</html>\n";
  const appJs = [
    "var projects = JSON.parse(localStorage.getItem('dash-projects') || 'null') || [{name: 'Website Redesign', tasks: [{text: 'Draft new homepage', done: true}, {text: 'Update colours', done: false}, {text: 'Test on mobile', done: false}]}, {name: 'Mini Project', tasks: [{text: 'Write synopsis', done: true}, {text: 'Build demo', done: false}]}];",
    "function saveDash(){ localStorage.setItem('dash-projects', JSON.stringify(projects)); renderDash(); }",
    "function renderDash(){ var total = 0; var done = 0; projects.forEach(function(p){ p.tasks.forEach(function(t){ total++; if(t.done) done++; }); }); document.getElementById('stats').innerHTML = '<div class=\"card\"><h3>Projects</h3><p>' + projects.length + '</p></div><div class=\"card\"><h3>Tasks</h3><p>' + total + '</p></div><div class=\"card\"><h3>Done</h3><p>' + done + ' (' + (total ? Math.round(done * 100 / total) : 0) + '%)</p></div>'; var sel = document.getElementById('taskProject'); sel.innerHTML = ''; projects.forEach(function(p, i){ var o = document.createElement('option'); o.value = String(i); o.textContent = p.name; sel.appendChild(o); }); var html = ''; projects.forEach(function(p, pi){ var d = p.tasks.filter(function(t){ return t.done; }).length; var pct = p.tasks.length ? Math.round(d * 100 / p.tasks.length) : 0; html += '<div class=\"card\"><h3>' + p.name + ' — ' + pct + '%</h3><div class=\"bar\"><div style=\"width:' + pct + '%\"></div></div>'; p.tasks.forEach(function(t, ti){ html += '<p><input type=\"checkbox\" ' + (t.done ? 'checked' : '') + ' onchange=\"toggleTask(' + pi + ',' + ti + ')\"> ' + t.text + '</p>'; }); html += '</div>'; }); document.getElementById('projects').innerHTML = html; }",
    "function toggleTask(pi, ti){ projects[pi].tasks[ti].done = !projects[pi].tasks[ti].done; saveDash(); }",
    "function addTask(){ var text = document.getElementById('taskText').value.trim(); if(!text) return; var pi = Number(document.getElementById('taskProject').value); projects[pi].tasks.push({text: text, done: false}); document.getElementById('taskText').value = ''; saveDash(); }",
    "renderDash();"
  ].join("\n");
  return {
    description: "A complete multi-file project dashboard: projects, tasks, progress bars, stats and browser persistence.",
    files: [
      { content: index, path: "index.html" },
      { content: CSS + "\n", path: "style.css" },
      { content: appJs + "\n", path: "app.js" },
      { content: readme(title, "A complete multi-file project dashboard: projects, tasks, progress bars, stats and browser persistence.", "Open `index.html` in a browser, or serve the folder with `python3 -m http.server 8000`."), path: "README.md" }
    ],
    title,
    type: "dashboard"
  };
}

function fullstackApp(title: string): MajorTemplateApp {
  const serverJs = [
    "const http = require('http');",
    "const fs = require('fs');",
    "const path = require('path');",
    "const DATA_FILE = path.join(__dirname, 'data.json');",
    "let items = [];",
    "try { items = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { items = [{ id: 1, title: 'Welcome item', done: false }]; }",
    "function save() { fs.writeFileSync(DATA_FILE, JSON.stringify(items, null, 2)); }",
    "function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }",
    "const server = http.createServer((req, res) => {",
    "  const url = new URL(req.url, 'http://localhost');",
    "  if (url.pathname === '/api/items' && req.method === 'GET') { send(res, 200, items); return; }",
    "  if (url.pathname === '/api/items' && req.method === 'POST') { let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => { try { const data = JSON.parse(body || '{}'); if (!data.title) { send(res, 400, { error: 'title is required' }); return; } const item = { id: Date.now(), title: String(data.title), done: false }; items.push(item); save(); send(res, 201, item); } catch (e) { send(res, 400, { error: 'invalid JSON' }); } }); return; }",
    "  if (url.pathname.startsWith('/api/items/') && req.method === 'DELETE') { const id = Number(url.pathname.split('/').pop()); items = items.filter((x) => x.id !== id); save(); send(res, 200, { ok: true }); return; }",
    "  let file = url.pathname === '/' ? '/index.html' : url.pathname;",
    "  const filePath = path.join(__dirname, 'public', file);",
    "  const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html';",
    "  fs.readFile(filePath, (err, data) => { if (err) { res.writeHead(404); res.end('Not found'); return; } res.writeHead(200, { 'Content-Type': type }); res.end(data); });",
    "});",
    "const PORT = process.env.PORT || 3000;",
    "server.listen(PORT, () => { console.log('Server running at http://localhost:' + PORT); });"
  ].join("\n");
  const pubIndex =
    "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<title>" +
    esc(title) +
    "</title>\n<link rel=\"stylesheet\" href=\"style.css\">\n</head>\n<body>\n<header><h1>" +
    esc(title) +
    "</h1><p>A full-stack app: this page talks to a real Node backend API.</p></header>\n<main>\n<div class=\"card\"><h2>Items from the API</h2><ul id=\"items\"></ul><input id=\"newItem\" placeholder=\"Add an item\"><button onclick=\"addItem()\">Add</button><p id=\"msg\"></p></div>\n</main>\n<script src=\"app.js\"></script>\n</body>\n</html>\n";
  const pubJs = [
    "async function loadItems(){ var res = await fetch('/api/items'); var items = await res.json(); var html = ''; items.forEach(function(it){ html += '<li>' + it.title + ' <button class=\"secondary\" onclick=\"deleteItem(' + it.id + ')\">Delete</button></li>'; }); document.getElementById('items').innerHTML = html || '<li>No items yet.</li>'; }",
    "async function addItem(){ var input = document.getElementById('newItem'); var title = input.value.trim(); if(!title) return; await fetch('/api/items', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({title: title})}); input.value = ''; loadItems(); }",
    "async function deleteItem(id){ await fetch('/api/items/' + id, {method: 'DELETE'}); loadItems(); }",
    "loadItems();"
  ].join("\n");
  const pkg = JSON.stringify({ name: "major-project", scripts: { start: "node server.js" }, version: "1.0.0" }, null, 2) + "\n";
  return {
    description: "A complete full-stack project: a Node backend with a JSON-persisted REST API, plus a frontend that uses it. No dependencies to install.",
    files: [
      { content: pkg, path: "package.json" },
      { content: serverJs + "\n", path: "server.js" },
      { content: pubIndex, path: "public/index.html" },
      { content: CSS + "\n", path: "public/style.css" },
      { content: pubJs + "\n", path: "public/app.js" },
      { content: readme(title, "A complete full-stack project: a Node backend with a JSON-persisted REST API, plus a frontend that uses it. No dependencies to install.", "Run `node server.js`, then visit http://localhost:3000"), path: "README.md" }
    ],
    title,
    type: "fullstack"
  };
}

export function buildMajorTemplateApp(prompt: string): MajorTemplateApp {
  const title = titleFromPrompt(prompt);
  const lower = prompt.toLowerCase();
  if (lower.includes("shop") || lower.includes("store") || lower.includes("ecommerce") || lower.includes("e-commerce")) {
    return shopApp(title);
  }
  if (lower.includes("blog") || lower.includes("cms") || lower.includes("news")) {
    return blogApp(title);
  }
  if (lower.includes("dashboard") || lower.includes("admin") || lower.includes("task management")) {
    return dashboardApp(title);
  }
  return fullstackApp(title);
}
