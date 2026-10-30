export interface TemplateFile {
  content: string;
  path: string;
}

export interface TemplateApp {
  description: string;
  files: TemplateFile[];
  title: string;
  type: string;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function titleFromPrompt(prompt: string): string {
  let t = prompt
    .replace(/^(please\s+)?(create|build|make|develop|design|generate)\s+(an|a|the)?\s*/i, "")
    .replace(/\s+(website|web\s*app|app|site|page)\s*$/i, "")
    .replace(/[.!?]+$/g, "")
    .trim();
  if (!t) {
    t = "My App";
  }
  if (t.length > 50) {
    t = t.slice(0, 50).replace(/\s+\S*$/, "");
  }
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function page(title: string, heading: string, tagline: string, body: string, script: string): string {
  const lines = [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    "<title>" + esc(title) + "</title>",
    "<style>",
    "body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0f172a;color:#e2e8f0}",
    "header{padding:48px 20px;text-align:center;background:linear-gradient(135deg,#2563eb,#7c3aed)}",
    "header h1{margin:0 0 8px;font-size:2.2rem} header p{opacity:.9;max-width:640px;margin:0 auto}",
    "main{max-width:820px;margin:0 auto;padding:24px 16px}",
    ".card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:20px;margin:16px 0}",
    "input,textarea{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;margin:6px 0}",
    "button{background:#2563eb;color:#fff;border:0;border-radius:8px;padding:10px 16px;cursor:pointer;margin:4px 4px 4px 0}",
    "button.secondary{background:#334155} li{margin:8px 0} a{color:#93c5fd}",
    ".done{text-decoration:line-through;opacity:.6} .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}",
    "</style>",
    "</head>",
    "<body>",
    "<header><h1>" + esc(heading) + "</h1><p>" + esc(tagline) + "</p></header>",
    "<main>" + body + "</main>",
    "<script>",
    script,
    "</script>",
    "</body>",
    "</html>"
  ];
  return lines.join("\n");
}

function readme(title: string, description: string, howTo: string): string {
  return [
    "# " + title,
    "",
    description,
    "",
    "## Run it",
    "",
    howTo,
    "",
    "## Customise it",
    "",
    "Open `index.html` and edit the text, colours and content. No build step and no API key are needed for the built-in features.",
    ""
  ].join("\n");
}

export function buildTemplateApp(prompt: string): TemplateApp {
  const title = titleFromPrompt(prompt);
  const lower = prompt.toLowerCase();
  const openHowTo = "Just open `index.html` in a browser, or serve the folder with `python3 -m http.server 8000` and visit http://localhost:8000";

  if (lower.includes("todo") || lower.includes("to-do") || lower.includes("task")) {
    const body =
      '<div class="card"><h2>Your tasks</h2>' +
      '<input id="todoInput" placeholder="Add a task and press Enter or Add">' +
      '<button onclick="addTodo()">Add task</button>' +
      '<ul id="todoList"></ul><p id="todoCount"></p></div>' +
      '<div class="card"><p>Tasks are saved in your browser (localStorage), so they survive a refresh. This is a complete, working app — not a mockup.</p></div>';
    const script = [
      "var todos = JSON.parse(localStorage.getItem('localnest-todos') || '[]');",
      "function saveTodos(){ localStorage.setItem('localnest-todos', JSON.stringify(todos)); }",
      "function renderTodos(){ var list = document.getElementById('todoList'); list.innerHTML = ''; todos.forEach(function(t, i){ var li = document.createElement('li'); li.className = t.done ? 'done' : ''; li.textContent = t.text + ' '; var doneBtn = document.createElement('button'); doneBtn.textContent = t.done ? 'Undo' : 'Done'; doneBtn.onclick = function(){ todos[i].done = !todos[i].done; saveTodos(); renderTodos(); }; var delBtn = document.createElement('button'); delBtn.className = 'secondary'; delBtn.textContent = 'Delete'; delBtn.onclick = function(){ todos.splice(i, 1); saveTodos(); renderTodos(); }; li.appendChild(doneBtn); li.appendChild(delBtn); list.appendChild(li); }); document.getElementById('todoCount').textContent = todos.filter(function(t){ return !t.done; }).length + ' left to do'; }",
      "function addTodo(){ var input = document.getElementById('todoInput'); var text = input.value.trim(); if(!text) return; todos.push({text: text, done: false}); input.value = ''; saveTodos(); renderTodos(); }",
      "document.getElementById('todoInput').addEventListener('keydown', function(e){ if(e.key === 'Enter') addTodo(); });",
      "renderTodos();"
    ].join("\n");
    return {
      description: "A complete todo web app with add, complete, undo, delete and localStorage persistence.",
      files: [
        { content: page(title, title, "Add tasks, tick them off, and pick up where you left off.", body, script), path: "index.html" },
        { content: readme(title, "A complete todo web app with add, complete, undo, delete and localStorage persistence.", openHowTo), path: "README.md" }
      ],
      title,
      type: "todo"
    };
  }

  if (lower.includes("weather")) {
    const body =
      '<div class="card"><h2>Check the weather</h2>' +
      '<input id="cityInput" placeholder="Enter a city, e.g. Bengaluru" value="Bengaluru">' +
      '<button onclick="searchWeather()">Search</button><div id="weatherResult"></div></div>' +
      '<div class="card"><p>Uses the free Open-Meteo APIs — no API key needed.</p></div>';
    const script = [
      "async function searchWeather(){ var city = document.getElementById('cityInput').value.trim(); var out = document.getElementById('weatherResult'); if(!city){ out.textContent = 'Enter a city first.'; return; } out.textContent = 'Loading...'; try { var geo = await fetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(city) + '&count=1'); var geoData = await geo.json(); if(!geoData.results || !geoData.results.length){ out.textContent = 'City not found. Try another spelling.'; return; } var place = geoData.results[0]; var fc = await fetch('https://api.open-meteo.com/v1/forecast?latitude=' + place.latitude + '&longitude=' + place.longitude + '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m'); var data = await fc.json(); out.innerHTML = '<h3>' + place.name + ', ' + (place.country || '') + '</h3><p>Temperature: ' + data.current.temperature_2m + ' C</p><p>Humidity: ' + data.current.relative_humidity_2m + '%</p><p>Wind: ' + data.current.wind_speed_10m + ' km/h</p>'; } catch(e){ out.textContent = 'Could not load weather. Check your internet connection and try again.'; } }",
      "searchWeather();"
    ].join("\n");
    return {
      description: "A working weather web app using the free, no-key Open-Meteo APIs.",
      files: [
        { content: page(title, title, "Live weather for any city, straight from Open-Meteo.", body, script), path: "index.html" },
        { content: readme(title, "A working weather web app using the free, no-key Open-Meteo APIs.", openHowTo), path: "README.md" }
      ],
      title,
      type: "weather"
    };
  }

  if (lower.includes("calculator") || lower.includes("calc")) {
    const body =
      '<div class="card"><h2>Calculator</h2>' +
      '<input id="calcDisplay" readonly placeholder="0">' +
      '<div class="grid">' +
      ["7", "8", "9", "/", "4", "5", "6", "*", "1", "2", "3", "-", "0", ".", "=", "+"]
        .map(function(v) {
          return '<button onclick="pressCalc(\'' + v + '\')">' + v + "</button>";
        })
        .join("") +
      '</div><button class="secondary" onclick="clearCalc()">Clear</button></div>';
    const script = [
      "function pressCalc(v){ var d = document.getElementById('calcDisplay'); if(v === '='){ try { if(!/^[0-9+\\-*/.() ]+$/.test(d.value)) throw new Error('bad'); d.value = String(eval(d.value)); } catch(e){ d.value = 'Error'; } } else { d.value = (d.value === 'Error' ? '' : d.value) + v; } }",
      "function clearCalc(){ document.getElementById('calcDisplay').value = ''; }"
    ].join("\n");
    return {
      description: "A complete calculator web app with all four operations.",
      files: [
        { content: page(title, title, "A calculator that actually calculates.", body, script), path: "index.html" },
        { content: readme(title, "A complete calculator web app with all four operations.", openHowTo), path: "README.md" }
      ],
      title,
      type: "calculator"
    };
  }

  if (lower.includes("quiz")) {
    const body =
      '<div class="card"><h2>Quiz</h2><div id="quizBox"></div><p id="quizScore"></p></div>';
    const script = [
      "var questions = [{q: 'Which language runs in the browser?', options: ['Python', 'JavaScript', 'C++'], answer: 1}, {q: 'What does HTML stand for?', options: ['Hyper Text Markup Language', 'High Tech Machine Language', 'Hyperlink Text Mode Language'], answer: 0}, {q: 'Which of these is a JavaScript framework?', options: ['Django', 'React', 'Laravel'], answer: 1}, {q: 'What is 7 x 8?', options: ['54', '56', '64'], answer: 1}];",
      "var qi = 0; var score = 0;",
      "function renderQuiz(){ var box = document.getElementById('quizBox'); if(qi >= questions.length){ box.innerHTML = '<h3>Done! You scored ' + score + ' out of ' + questions.length + '</h3><button onclick=\"qi=0;score=0;renderQuiz()\">Play again</button>'; document.getElementById('quizScore').textContent = ''; return; } var q = questions[qi]; var html = '<p><b>Question ' + (qi + 1) + ':</b> ' + q.q + '</p>'; q.options.forEach(function(opt, i){ html += '<button onclick=\"answerQuiz(' + i + ')\">' + opt + '</button>'; }); box.innerHTML = html; document.getElementById('quizScore').textContent = 'Score: ' + score; }",
      "function answerQuiz(i){ if(i === questions[qi].answer) score++; qi++; renderQuiz(); }",
      "renderQuiz();"
    ].join("\n");
    return {
      description: "A complete quiz web app with scoring and a play-again button.",
      files: [
        { content: page(title, title, "Answer, get scored, and play again.", body, script), path: "index.html" },
        { content: readme(title, "A complete quiz web app with scoring and a play-again button.", openHowTo), path: "README.md" }
      ],
      title,
      type: "quiz"
    };
  }

  if (lower.includes("note")) {
    const body =
      '<div class="card"><h2>Write a note</h2><textarea id="noteBox" rows="8" placeholder="Write anything..."></textarea>' +
      '<button onclick="saveNote()">Save note</button><button class="secondary" onclick="clearNote()">Clear</button><p id="noteStatus"></p></div>';
    const script = [
      "var noteBox = document.getElementById('noteBox'); noteBox.value = localStorage.getItem('localnest-note') || '';",
      "function saveNote(){ localStorage.setItem('localnest-note', noteBox.value); document.getElementById('noteStatus').textContent = 'Saved in your browser.'; }",
      "function clearNote(){ noteBox.value = ''; localStorage.removeItem('localnest-note'); document.getElementById('noteStatus').textContent = 'Cleared.'; }"
    ].join("\n");
    return {
      description: "A complete notes web app that saves to your browser.",
      files: [
        { content: page(title, title, "A simple note that saves itself in your browser.", body, script), path: "index.html" },
        { content: readme(title, "A complete notes web app that saves to your browser.", openHowTo), path: "README.md" }
      ],
      title,
      type: "notes"
    };
  }

  if (lower.includes("portfolio") || lower.includes("personal website") || lower.includes("resume")) {
    const body =
      '<div class="card"><h2>About me</h2><p>Hi, I build things for the web. Replace this text with your own story, skills and links.</p></div>' +
      '<div class="card"><h2>Projects</h2><div class="grid"><div class="card"><h3>Project One</h3><p>A short description of what it does and why it matters.</p></div><div class="card"><h3>Project Two</h3><p>A short description of what it does and why it matters.</p></div><div class="card"><h3>Project Three</h3><p>A short description of what it does and why it matters.</p></div></div></div>' +
      '<div class="card"><h2>Contact</h2><form id="contactForm"><input placeholder="Your name" required><input placeholder="Your email" required><textarea placeholder="Your message" required></textarea><button>Send message</button></form><p id="contactStatus"></p></div>';
    const script = [
      "document.getElementById('contactForm').addEventListener('submit', function(e){ e.preventDefault(); document.getElementById('contactStatus').textContent = 'Thanks! Your message was noted (wire this form to your email or backend to receive it for real).'; });"
    ].join("\n");
    return {
      description: "A complete portfolio website with about, projects and a contact form.",
      files: [
        { content: page(title, title, "A portfolio you can make your own in minutes.", body, script), path: "index.html" },
        { content: readme(title, "A complete portfolio website with about, projects and a contact form.", openHowTo), path: "README.md" }
      ],
      title,
      type: "portfolio"
    };
  }

  // Generic website / landing fallback — always produces a real page.
  const body =
    '<div class="card"><h2>What this is</h2><p>' +
    esc(prompt) +
    "</p><p>This starter page was generated from your request. Edit the text and sections in index.html to make it exactly what you had in mind, or ask LocalNest in Build mode to rebuild it with more detail.</p></div>" +
    '<div class="card"><h2>Features</h2><div class="grid"><div class="card"><h3>Fast</h3><p>No build step — open and it works.</p></div><div class="card"><h3>Responsive</h3><p>Looks right on phone and desktop.</p></div><div class="card"><h3>Yours to edit</h3><p>Plain HTML, CSS and JavaScript, no framework lock-in.</p></div></div></div>' +
    '<div class="card"><h2>Get started</h2><button onclick="showWelcome()">Say hello</button><p id="welcome"></p></div>';
  const script = "function showWelcome(){ document.getElementById('welcome').textContent = 'Hello! This page is live and ready to customise.'; }";
  return {
    description: "A complete, responsive starter website generated from your request.",
    files: [
      { content: page(title, title, "A working starter website, ready to customise.", body, script), path: "index.html" },
      { content: readme(title, "A complete, responsive starter website generated from your request.", openHowTo), path: "README.md" }
    ],
    title,
    type: "website"
  };
}
