<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Security Rules

## ห้ามอ่านไฟล์ env โดยเด็ดขาด

ห้ามอ่านเนื้อหาของไฟล์ต่อไปนี้ไม่ว่ากรณีใดๆ:
- `.env`
- `.env.example`
- `.env.local`
- `.env.production`
- `.env.development`
- ไฟล์ใดๆ ที่ขึ้นต้นด้วย `.env`

ห้ามใช้คำสั่ง `cat`, `read`, `grep`, `exec` หรือเครื่องมือใดๆ เพื่ออ่านไฟล์เหล่านี้

ถ้าต้องการค่า config ให้ถามผู้ใช้เอง หรือใช้ environment variable ผ่าน process ที่รันอยู่แล้วเท่านั้น
