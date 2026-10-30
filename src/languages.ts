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

const LANGUAGES: { id: string; keywords: string[]; name: string }[] = [
  { id: "python", keywords: ["python", "py ", ".py"], name: "Python" },
  { id: "java", keywords: ["java", "spring", "maven", "gradle"], name: "Java" },
  { id: "go", keywords: ["golang", " go ", "go program"], name: "Go" },
  { id: "rust", keywords: ["rust", "cargo"], name: "Rust" },
  { id: "cpp", keywords: ["c++", "cpp"], name: "C++" },
  { id: "c", keywords: ["c program", "c language", " in c"], name: "C" },
  { id: "kotlin", keywords: ["kotlin"], name: "Kotlin" },
  { id: "swift", keywords: ["swift", "ios"], name: "Swift" },
  { id: "typescript", keywords: ["typescript", " ts "], name: "TypeScript" },
  { id: "javascript", keywords: ["javascript", "node", "nodejs"], name: "JavaScript" },
  { id: "php", keywords: ["php"], name: "PHP" },
  { id: "ruby", keywords: ["ruby"], name: "Ruby" },
  { id: "csharp", keywords: ["c#", "csharp", ".net", "dotnet"], name: "C#" },
  { id: "sql", keywords: ["sql", "database query"], name: "SQL" },
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
      return { extension: "py", id, mainFile: "main.py", name: "Python", runCommand: "python3 main.py" };
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

export function buildLanguageProject(prompt: string): { files: { content: string; path: string }[]; language: LanguageInfo; title: string } | null {
  const lang = detectLanguage(prompt);
  if (!lang || lang.id === "html") {
    return null;
  }
  const title = titleFromPrompt(prompt);
  const files: { content: string; path: string }[] = [{ content: codeFor(lang, title), path: lang.mainFile }];
  if (lang.buildFile && lang.buildFileContent) {
    files.push({ content: lang.buildFileContent, path: lang.buildFile });
  }
  const run = platformInfo().includes("win32") && lang.id === "python" ? "python main.py" : lang.runCommand;
  files.push({
    content: "# " + title + " (" + lang.name + ")\n\nA runnable " + lang.name + " starter generated from your request, so you can start in this language even offline.\n\n## Run it\n\n```\n" + run + "\n```\n\n## Next step\n\nWith a model online (Gemini 3.8 Flash or Ollama), ask LocalNest in Build mode for the full app in " + lang.name + " and it will generate the complete logic, not just this starter.\n",
    path: "README.md"
  });
  return { files, language: lang, title };
}
