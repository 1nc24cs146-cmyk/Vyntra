import * as os from "os";
import { titleFromPrompt } from "./templates";

export interface LanguageInfo {
  buildFile?: string;
  buildFileContent?: string;
  extension: string;
  id: string;
  mainFile: string;
  name: string;
  runCommand: string;
}

// Order matters: JavaScript/TypeScript come before Java, because
// "javascript" contains "java" as a substring — otherwise every
// JavaScript request was mis-detected as Java.
const LANGUAGES: { id: string; keywords: string[]; name: string }[] = [
  { id: "python", keywords: ["python", "py ", " py", ".py", "django", "flask", "fastapi", "pandas", "numpy", "pytest"], name: "Python" },
  { id: "typescript", keywords: ["typescript", " ts ", ".ts", ".tsx", "angular", "nestjs"], name: "TypeScript" },
  { id: "javascript", keywords: ["javascript", "node", "nodejs", ".js", ".jsx", "react", "express", "vue", "jest", "npm"], name: "JavaScript" },
  { id: "java", keywords: ["java", "spring", "maven", "gradle", "junit", ".java", "spring boot"], name: "Java" },
  { id: "go", keywords: ["golang", " go ", "go program", ".go", "gin", "fiber"], name: "Go" },
  { id: "rust", keywords: ["rust", "cargo", ".rs", "tokio", "serde"], name: "Rust" },
  { id: "cpp", keywords: ["c++", "cpp", ".cpp", ".hpp", "cmake"], name: "C++" },
  { id: "c", keywords: ["c program", "c language", " in c", ".c", "gcc"], name: "C" },
  { id: "kotlin", keywords: ["kotlin", ".kt", "android", "jetpack"], name: "Kotlin" },
  { id: "swift", keywords: ["swift", "ios", ".swift", "swiftui", "xcode"], name: "Swift" },
  { id: "php", keywords: ["php", ".php", "laravel", "composer", "wordpress"], name: "PHP" },
  { id: "ruby", keywords: ["ruby", ".rb", "rails", "sinatra", "rspec"], name: "Ruby" },
  { id: "csharp", keywords: ["c#", "csharp", ".net", "dotnet", ".cs", "asp.net", "blazor"], name: "C#" },
  { id: "sql", keywords: ["sql", "database query", "postgres", "mysql", "sqlite", "select "], name: "SQL" },
  { id: "html", keywords: ["html", "website", "web page", "web app", "webapp"], name: "HTML/CSS/JS" }
];

export function detectLanguage(prompt: string): LanguageInfo | null {
  const lower = " " + prompt.toLowerCase() + " ";
  for (const lang of LANGUAGES) {
    if (lang.keywords.some((k) => lower.includes(k))) {
      return languageInfo(lang.id);
    }
  }
  return null;
}

export function languageInfo(id: string): LanguageInfo {
  switch (id) {
    case "python":
      return { extension: "py", id, mainFile: "main.py", name: "Python", runCommand: os.platform() === "win32" ? "python main.py" : "python3 main.py" };
    case "java":
      return { extension: "java", id, mainFile: "Main.java", name: "Java", runCommand: "javac Main.java && java Main" };
    case "go":
      return { buildFile: "go.mod", buildFileContent: "module localnest-app\n\ngo 1.21\n", extension: "go", id, mainFile: "main.go", name: "Go", runCommand: "go run ." };
    case "rust":
      return { buildFile: "Cargo.toml", buildFileContent: '[package]\nname = "localnest-app"\nversion = "0.1.0"\nedition = "2021"\n', extension: "rs", id, mainFile: "src/main.rs", name: "Rust", runCommand: "cargo run" };
    case "cpp":
      return { extension: "cpp", id, mainFile: "main.cpp", name: "C++", runCommand: "g++ -std=c++17 main.cpp -o app && ./app" };
    case "c":
      return { extension: "c", id, mainFile: "main.c", name: "C", runCommand: "gcc main.c -o app && ./app" };
    case "kotlin":
      return { extension: "kt", id, mainFile: "Main.kt", name: "Kotlin", runCommand: "kotlinc Main.kt -include-runtime -d app.jar && java -jar app.jar" };
    case "swift":
      return { extension: "swift", id, mainFile: "main.swift", name: "Swift", runCommand: "swift main.swift" };
    case "typescript":
      return { extension: "ts", id, mainFile: "main.ts", name: "TypeScript", runCommand: "npx ts-node main.ts" };
    case "javascript":
      return { extension: "js", id, mainFile: "main.js", name: "JavaScript", runCommand: "node main.js" };
    case "php":
      return { extension: "php", id, mainFile: "index.php", name: "PHP", runCommand: "php index.php" };
    case "ruby":
      return { extension: "rb", id, mainFile: "main.rb", name: "Ruby", runCommand: "ruby main.rb" };
    case "csharp":
      return { extension: "cs", id, mainFile: "Program.cs", name: "C#", runCommand: "dotnet run" };
    case "sql":
      return { extension: "sql", id, mainFile: "queries.sql", name: "SQL", runCommand: "Run queries.sql in your database client (psql / mysql / sqlite3)" };
    default:
      return { extension: "html", id: "html", mainFile: "index.html", name: "HTML/CSS/JS", runCommand: "Open index.html in a browser" };
  }
}

/** OS / shell / architecture info the model must use for commands, so generated commands work on this exact machine. */
export function platformInfo(): string {
  const platform = os.platform();
  const shell = platform === "win32" ? "PowerShell/cmd on Windows (use `python` not `python3`, `;` not `&&` in cmd, PowerShell uses `;` too)" : platform === "darwin" ? "zsh/bash on macOS" : "bash on Linux";
  return "Device: OS=" + platform + ", arch=" + os.arch() + ", shell=" + shell + ". Generate run/build/test commands for THIS platform and shell, not for another OS. On Windows, prefer `python` over `python3` and avoid Unix-only commands unless you also give the Windows equivalent.";
}

function codeFor(lang: LanguageInfo, title: string): string {
  const safeTitle = title.replace(/"/g, "");
  switch (lang.id) {
    case "python":
      return "# " + safeTitle + " — Python starter (works offline, no packages needed)\n# Run: python3 main.py  (on Windows: python main.py)\n\ndef main():\n    print('" + safeTitle + "')\n    print('Hello from Python! Edit main.py to build your app here.')\n    tasks = []\n    while True:\n        print('\\n1. Add task  2. List tasks  3. Quit')\n        choice = input('Choose: ').strip()\n        if choice == '1':\n            tasks.append(input('Task: ').strip())\n        elif choice == '2':\n            print(tasks if tasks else 'No tasks yet.')\n        elif choice == '3':\n            break\n\nif __name__ == '__main__':\n    main()\n";
    case "java":
      return "public class Main {\n    public static void main(String[] args) {\n        System.out.println(\"" + safeTitle + "\");\n        System.out.println(\"Hello from Java! Edit Main.java to build your app here.\");\n    }\n}\n";
    case "go":
      return "package main\n\nimport \"fmt\"\n\nfunc main() {\n    fmt.Println(\"" + safeTitle + "\")\n    fmt.Println(\"Hello from Go! Edit main.go to build your app here.\")\n}\n";
    case "rust":
      return "fn main() {\n    println!(\"" + safeTitle + "\");\n    println!(\"Hello from Rust! Edit src/main.rs to build your app here.\");\n}\n";
    case "cpp":
      return "#include <iostream>\nint main() {\n    std::cout << \"" + safeTitle + "\" << std::endl;\n    std::cout << \"Hello from C++! Edit main.cpp to build your app here.\" << std::endl;\n    return 0;\n}\n";
    case "c":
      return "#include <stdio.h>\nint main() {\n    printf(\"" + safeTitle + "\\n\");\n    printf(\"Hello from C! Edit main.c to build your app here.\\n\");\n    return 0;\n}\n";
    case "kotlin":
      return "fun main() {\n    println(\"" + safeTitle + "\")\n    println(\"Hello from Kotlin! Edit Main.kt to build your app here.\")\n}\n";
    case "swift":
      return "print(\"" + safeTitle + "\")\nprint(\"Hello from Swift! Edit main.swift to build your app here.\")\n";
    case "typescript":
      return "console.log(\"" + safeTitle + "\");\nconsole.log(\"Hello from TypeScript! Edit main.ts to build your app here.\");\n";
    case "javascript":
      return "console.log(\"" + safeTitle + "\");\nconsole.log(\"Hello from JavaScript! Edit main.js to build your app here.\");\n";
    case "php":
      return "<?php\n// " + safeTitle + "\necho \"" + safeTitle + "\\n\";\necho \"Hello from PHP! Edit index.php to build your app here.\\n\";\n";
    case "ruby":
      return "puts \"" + safeTitle + "\"\nputs \"Hello from Ruby! Edit main.rb to build your app here.\"\n";
    case "csharp":
      return "using System;\nclass Program {\n    static void Main() {\n        Console.WriteLine(\"" + safeTitle + "\");\n        Console.WriteLine(\"Hello from C#! Edit Program.cs to build your app here.\");\n    }\n}\n";
    case "sql":
      return "-- " + safeTitle + " — SQL starter\n-- Run this file in psql, mysql or sqlite3.\nCREATE TABLE IF NOT EXISTS items (\n    id INTEGER PRIMARY KEY,\n    title TEXT NOT NULL,\n    done INTEGER DEFAULT 0\n);\nINSERT INTO items (title) VALUES ('First item');\nSELECT * FROM items;\n";
    default:
      return "<!-- " + safeTitle + " -->\n<h1>" + safeTitle + "</h1>\n<p>Hello from the web starter.</p>\n";
  }
}


/** Per-language rules the model must follow for the detected language.
 * This is the "training" for one language at a time: idioms, project
 * files, run/test commands, and the libraries to prefer — so the model
 * does not fall back to generic JavaScript/web habits. */
export function languageGuidance(lang: LanguageInfo): string {
  switch (lang.id) {
    case "python":
      return " Python rules: use Python 3 only (never Python 2), type hints on public functions, f-strings, pathlib over os.path, and the standard library first. Use " + (os.platform() === "win32" ? "`python` (not `python3`) and `py -m pip`" : "`python3` and `pip3`") + " on this machine. Put any third-party package in requirements.txt and name it in the README. Prefer Flask for a small web app, FastAPI for an API, Django only if the user asked for it, requests for HTTP, pandas/numpy only for data work, and pytest/unittest for tests — include a runnable test file when you add logic. Never use `pip install` inside code; list it as a command instead.";
    case "javascript":
      return " JavaScript rules: use modern ES2022+, node for scripts, npm for packages, and package.json with start/test scripts. Prefer the standard library and fetch over new dependencies. React: functional components + hooks, no class components unless asked. Express: express.Router, JSON middleware, proper status codes, supertest for tests. Test with Jest or Vitest — include a runnable test file when you add logic.";
    case "typescript":
      return " TypeScript rules: strict types, no `any` unless unavoidable, tsconfig with strict mode, and `npx tsc` to check before running. Angular: standalone components, signals, HttpClient. NestJS: controllers + services + modules, no logic in controllers.";
    case "java":
      return " Java rules: Java 17+, no raw types, records for plain data, try-with-resources, and Maven (pom.xml) or Gradle for dependencies — never a bare .jar in the repo. Spring Boot for a web app or API, JUnit 5 for tests (include a runnable test), and `javac`/`java` or `mvn test` to check before running.";
    case "go":
      return " Go rules: gofmt-formatted code, `go mod` for dependencies, error return values checked (never ignored), and `go test ./...` to check. Gin or the standard net/http for a web app, never a framework the user did not ask for.";
    case "rust":
      return " Rust rules: ownership-safe code, no `unwrap()` in library code (return Result), Cargo.toml for dependencies, and `cargo test` to check. tokio only for async work the user asked for, serde for JSON.";
    case "c":
      return " C rules: C17, no gets(), check malloc/free pairs, -Wall -Wextra clean, and `gcc -Wall -Wextra` to check before running.";
    case "cpp":
      return " C++ rules: C++17+, RAII and smart pointers (no raw new/delete in new code), std::vector over raw arrays, CMake for multi-file projects, and `g++ -std=c++17 -Wall -Wextra` to check.";
    case "kotlin":
      return " Kotlin rules: null-safety (no !! unless justified), data classes for plain data, coroutines only for async work, and `kotlinc` + JUnit for tests. Android: Jetpack Compose, ViewModel, no logic in the UI layer.";
    case "swift":
      return " Swift rules: Swift 5+, optionals handled safely (no force-unwrap in new code), SwiftUI for iOS UI, and `swift test` / `swift build` to check.";
    case "php":
      return " PHP rules: PHP 8+, strict types (`declare(strict_types=1)`), prepared statements for every database query (never string-concatenated SQL), Composer for dependencies, Laravel only if the user asked for it, and PHPUnit for tests.";
    case "ruby":
      return " Ruby rules: Ruby 3+, Bundler/Gemfile for dependencies, Rails only if the user asked for it, RSpec/Minitest for tests, and `ruby` / `bundle exec rspec` to check.";
    case "csharp":
      return " C# rules: C# 12+, nullable reference types on, LINQ over manual loops, async/await for I/O, ASP.NET Core for a web app/API, and `dotnet test` to check.";
    case "sql":
      return " SQL rules: parameterised queries only (never string-concatenated values), explicit column lists (no SELECT * in app code), and a CREATE TABLE + INSERT + SELECT that actually runs in the target database (PostgreSQL/MySQL/SQLite — say which).";
    case "html":
      return " HTML/CSS/JS rules: semantic HTML, one self-contained index.html unless the user asked for separate files, CSS in <style> or style.css, JS in <script> or app.js, CSP meta tag, textContent not innerHTML for user data, and localStorage for persistence.";
    default:
      return "";
  }
}

export function fullLanguageGuidance(lang: LanguageInfo): string {
  return languageGuidance(lang) + realWorldTasks(lang);
}


/** Real-world problems each language is actually used for, and the stack
 * to reach for. This is the "train for real-world problems" pass: when the
 * user describes a real problem (an API, a login system, a report, a
 * migration), the model should build that, with validation, errors,
 * persistence and tests — not a hello-world starter. */
export function realWorldTasks(lang: LanguageInfo): string {
  switch (lang.id) {
    case "python":
      return " Real-world work in Python: REST API (FastAPI with Pydantic validation, or Flask), login/auth (JWT, hashed passwords, never plain text), database CRUD (SQLAlchemy + migrations, parameterised queries), data pipeline/report (pandas, CSV/Excel in and out), automation script, web scraping (requests + BeautifulSoup, respect robots.txt). Always: env vars for secrets, pagination on list endpoints, proper error responses, logging, and a test for each route.";
    case "javascript":
      return " Real-world work in JavaScript: REST API (Express — validation, auth middleware, rate limiting, pagination), React app (forms with validation, API error states, loading states), CLI tool, file upload/download, real-time chat (WebSocket), cron/scheduled job. Always: validate every input, never trust the client, handle network failures, and include a test for each route/component.";
    case "typescript":
      return " Real-world work in TypeScript: REST API (NestJS — controllers, services, DTO validation, guards for auth), Angular app (forms, guards, interceptors for tokens), typed API client, background job. Always: strict types end to end, DTO validation on every endpoint, auth guards, and tests for controllers and services.";
    case "java":
      return " Real-world work in Java: Spring Boot REST API (validation, JWT security, pagination, exception handlers), microservice, batch job, database CRUD (Spring Data JPA, migrations with Flyway/Liquibase). Always: validate DTOs, return proper HTTP statuses, handle exceptions centrally, and test controllers with MockMvc.";
    case "go":
      return " Real-world work in Go: REST API (Gin or net/http — middleware for auth/logging, pagination), CLI tool, background worker, microservice. Always: context with timeouts, structured errors, graceful shutdown, and httptest suites for handlers.";
    case "rust":
      return " Real-world work in Rust: REST API (axum/actix — typed handlers, error types), CLI tool, background worker, systems tool. Always: Result-based errors (no unwrap in production paths), config from env, and tests for every public function.";
    case "c":
      return " Real-world work in C: embedded/firmware code, system tool, file parser, network client. Always: check every malloc/fopen return, bound-check buffers, no gets(), and a test harness for the core logic.";
    case "cpp":
      return " Real-world work in C++: desktop app, game engine code, high-performance service, file/network tool. Always: RAII, no raw new/delete, bounds-checked containers, and unit tests for the core logic.";
    case "kotlin":
      return " Real-world work in Kotlin: Android app (Compose + ViewModel + Room database, offline-first), Spring Boot API. Always: handle offline/no-network states, loading and error UI states, and tests for ViewModels and repositories.";
    case "swift":
      return " Real-world work in Swift: iOS app (SwiftUI + MVVM, Core Data/URLSession, offline handling), macOS tool. Always: handle offline states, loading/error UI, and tests for view models and network code.";
    case "php":
      return " Real-world work in PHP: Laravel web app/API (validation, auth, Eloquent + migrations), WordPress plugin/theme, form + payment flow. Always: prepared statements, CSRF protection, validate and sanitise every input, and feature tests for routes.";
    case "ruby":
      return " Real-world work in Ruby: Rails app/API (validations, auth with Devise or JWT, ActiveRecord + migrations), background job (Sidekiq). Always: strong parameters, validate models, and request specs for controllers.";
    case "csharp":
      return " Real-world work in C#: ASP.NET Core API (validation, JWT auth, Entity Framework + migrations), desktop app (WPF/MAUI), background service. Always: validate DTOs, return proper statuses, handle exceptions centrally, and tests for controllers and services.";
    case "sql":
      return " Real-world work in SQL: reporting query (joins, window functions, aggregates), migration script (up/down, idempotent), data cleanup, dashboard query. Always: parameterised values, indexes on filter/join columns, and a sample result in the README.";
    default:
      return " Real-world work on the web: login + signup flow, product/shop with cart and checkout, dashboard with real data, form with validation and error states, search + filters + pagination. Always: validate inputs, show loading and error states, persist data (localStorage or a backend), and make it work without a network where possible.";
  }
}

export function buildLanguageProject(prompt: string): { files: { content: string; path: string }[]; language: LanguageInfo; title: string } | null {
  const lang = detectLanguage(prompt);
  if (!lang || lang.id === "html") {
    return null;
  }
  const title = titleFromPrompt(prompt);
  const files: { content: string; path: string }[] = [{ content: codeFor(lang, title), path: lang.mainFile }];
  if (lang.id === "python") {
    files.push({ content: "import unittest\n\n\nclass TestStarter(unittest.TestCase):\n    def test_main_runs(self):\n        # The starter's main() is interactive, so test the import only:\n        # if main.py imports cleanly, the project is wired correctly.\n        import main\n        self.assertTrue(hasattr(main, 'main'))\n\n\nif __name__ == '__main__':\n    unittest.main()\n", path: "test_main.py" });
    files.push({ content: "# Add one package per line, e.g. requests, flask, fastapi\n# Install with: pip install -r requirements.txt\n", path: "requirements.txt" });
  }
  if (lang.buildFile && lang.buildFileContent) {
    files.push({ content: lang.buildFileContent, path: lang.buildFile });
  }
  const run = platformInfo().includes("win32") && lang.id === "python" ? "python main.py" : lang.runCommand;
  files.push({
    content: "# " + title + " (" + lang.name + ")\n\nA runnable " + lang.name + " starter generated from your request, so you can start in this language even offline.\n\n## Run it\n\n```\n" + run + "\n```\n\n## Next step\n\nWith a model online (Gemini 3.8 Flash or Ollama), ask Vyntra in Build mode for the full app in " + lang.name + " and it will generate the complete logic, not just this starter.\n",
    path: "README.md"
  });
  return { files, language: lang, title };
}
