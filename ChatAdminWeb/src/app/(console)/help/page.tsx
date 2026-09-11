"use client";
import { useState, useMemo } from "react";
import Link from "next/link";
import { PageShell } from "@/components/ui/PageShell";
import { HelpCircle, BookOpen, Zap, MessageSquare, Bot, Users, Scale, FlaskConical, Ghost, GitBranch, Settings2, Search, ArrowRight } from "lucide-react";
import { ACTION_CATEGORIES } from "@/lib/actionTypes";

const glossary: { term: string; en: string; desc: string; link?: string }[] = [
  { term: "Shadow Inbox", en: "Shadow Inbox", desc: "หน้าทดสอบบอทแบบเงียบ — ดูคำตอบบอทเทียบกับแอดมินจริงโดยไม่ส่งถึงลูกค้า", link: "/shadow-inbox" },
  { term: "Replay Compare", en: "Replay Compare", desc: "เปรียบเทียบคำตอบบอท vs Zaapi แชทเก่า เพื่อวัดคุณภาพบอท", link: "/replay-compare" },
  { term: "Bot Worker", en: "Bot Worker", desc: "ระบบประมวลผลแชทเข้าแบบ batch — รวมข้อความ ส่งบอท บันทึกคำตอบ", link: "/botworker" },
  { term: "ทดสอบจ่ายงาน", en: "Test Assignment", desc: "ทดสอบการจ่ายงานแชทให้แอดมิน — ดูว่าบอทตอบเองหรือส่งต่อแอดมิน", link: "/test-assignment" },
  { term: "Roll", en: "Roll Mode", desc: "โหมดทดสอบที่รัน replay ทีละแชทตามลำดับ แทน batch พร้อมกัน", link: "/replay-compare" },
  { term: "Workflow", en: "Workflow", desc: "Flow หลายขั้นตอนแบบ Zaapi — กำหนด trigger + branch + action ตามเงื่อนไข", link: "/workflows" },
  { term: "Trigger", en: "Trigger", desc: "คำที่บอทดักจับเพื่อเข้า flow เฉพาะ (เช่น 'รับประกัน' เข้า warranty flow)", link: "/triggers" },
  { term: "Handoff", en: "Handoff", desc: "การส่งแชทจากบอทไปยังแอดมิน — บอทเลิกตอบ แอดมินรับงานต่อ" },
  { term: "Knowledge Base", en: "Knowledge Base", desc: "ฐานความรู้ที่บอทใช้ตอบ — ข้อมูลสินค้า คำถามที่พบบ่อย", link: "/knowledge" },
  { term: "Persona", en: "Persona", desc: "บุคลิกของบอท — กำหนดน้ำเสียง สไตล์การตอบ", link: "/persona" },
];

const gettingStarted: { icon: typeof Zap; title: string; desc: string; link: string }[] = [
  { icon: Settings2, title: "1. ตั้งค่าระบบ", desc: "ไปที่ Config เปิดสวิตช์ระบบแชท เลือก platform ที่จะใช้", link: "/config" },
  { icon: BookOpen, title: "2. เพิ่ม Knowledge", desc: "ไปที่ Knowledge เพิ่มข้อมูลสินค้า คำถามที่พบบ่อย", link: "/knowledge" },
  { icon: Zap, title: "3. สร้าง Trigger", desc: "ไปที่ Triggers กำหนดคำที่บอทดักจับ เพื่อเข้า flow เฉพาะ", link: "/triggers" },
  { icon: GitBranch, title: "4. สร้าง Workflow", desc: "ไปที่ Workflows สร้าง flow หลายขั้นตอน (เผื่ออนาคต)", link: "/workflows" },
  { icon: FlaskConical, title: "5. ทดสอบบอท", desc: "ไปที่ Shadow Inbox หรือ Test Chat ทดสอบบอทก่อนใช้จริง", link: "/shadow-inbox" },
  { icon: Scale, title: "6. เปรียบเทียบ", desc: "ไปที่ Replay Compare เปรียบเทียบคำตอบบอท vs แอดมิน", link: "/replay-compare" },
];

const features: { icon: typeof Bot; title: string; desc: string; link: string }[] = [
  { icon: MessageSquare, title: "แชทสด", desc: "ดูแชทเข้าแบบเรียลไทม์ ตอบลูกค้า ส่งต่อแอดมิน", link: "/tickets" },
  { icon: Bot, title: "บอทตอบอัตโนมัติ", desc: "บอทตอบคำถามทั่วไป แนะนำสินค้า จาก Knowledge Base", link: "/knowledge" },
  { icon: Users, title: "จ่ายงานแอดมิน", desc: "ระบบจ่ายงานแชทให้แอดมินแบบ round-robin หรือติดแอดมินคนเดิม", link: "/live-assignment" },
  { icon: Ghost, title: "Shadow Test", desc: "ทดสอบบอทแบบเงียบ ไม่ส่งถึงลูกค้า เปรียบเทียบกับแอดมิน", link: "/shadow-inbox" },
];

const pageAnchors: { id: string; title: string; desc: string; link: string }[] = [
  { id: "dashboard", title: "แดชบอร์ด", desc: "ภาพรวมสถิติบอท แชท และการจ่ายงาน", link: "/dashboard" },
  { id: "replay-compare", title: "เปรียบเทียบรีเพลย์", desc: "เปรียบเทียบคำตอบบอท vs Zaapi/แอดมิน เพื่อวัดคุณภาพบอท", link: "/replay-compare" },
  { id: "workflows", title: "เวิร์กโฟลว์", desc: "สร้างและจัดการ flow หลายขั้นตอน — กำหนด trigger + branch + action", link: "/workflows" },
  { id: "triggers", title: "ทริกเกอร์", desc: "คำที่บอทดักจับเพื่อเข้า flow เฉพาะ (เช่น 'รับประกัน' เข้า warranty flow)", link: "/triggers" },
  { id: "quick-replies", title: "คำตอบเร็ว", desc: "คำตอบสำเร็จรูปที่แอดมินใช้ตอบลูกค้า จัดหมวดหมู่ ค้นหา และเปิด/ปิดได้", link: "/quick-replies" },
  { id: "knowledge", title: "ฐานความรู้", desc: "ฐานความรู้ที่บอทใช้ตอบ — ข้อมูลสินค้า คำถามที่พบบ่อย", link: "/knowledge" },
  { id: "persona", title: "ตัวแทนร้าน", desc: "บุคลิกของบอท — น้ำเสียง สไตล์การตอบ", link: "/persona" },
  { id: "config", title: "ตั้งค่าระบบ", desc: "เปิด/ปิดระบบแชท เลือก platform ตั้งค่าความปลอดภัย", link: "/config" },
  { id: "admin-config", title: "ตั้งค่าแอดมิน", desc: "ตั้งค่า Buffering, Workflow Engine, Assignment, LLM Context Limit", link: "/admin-config" },
  { id: "shop-settings", title: "ตั้งค่าร้าน", desc: "จัดการประเภทข้อความพิเศษของแต่ละร้าน (เช่น faq_liveagent)", link: "/shop-settings" },
  { id: "logs", title: "ประวัติการกระทำ", desc: "ดูประวัติการกระทำของแอดมิน กรองตาม action/ชื่อ/รหัสแชท", link: "/logs" },
  { id: "team", title: "ทีม & มอบหมาย", desc: "จัดการทีมแอดมิน มอบหมายร้านค้า ตั้งค่าการจ่ายงาน", link: "/team" },
  { id: "shops", title: "ร้านค้า", desc: "รายการร้านค้าที่เชื่อมต่อ สถานะ แพลตฟอร์ม", link: "/shops" },
  { id: "contacts", title: "รายชื่อลูกค้า", desc: "รายชื่อลูกค้าที่เคยติดต่อ ประวัติแชท", link: "/contacts" },
  { id: "users", title: "จัดการผู้ใช้", desc: "สร้าง/แก้ไข/ลบผู้ใช้ กำหนด role (SuperAdmin/Admin/Dev)", link: "/users" },
];

export default function HelpPage() {
  // 🔒 P2c: Add search functionality
  const [search, setSearch] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);

  const q = search.toLowerCase().trim();

  const filteredGlossary = useMemo(() => {
    if (!q) return glossary;
    return glossary.filter(
      (g) =>
        g.term.toLowerCase().includes(q) ||
        g.en.toLowerCase().includes(q) ||
        g.desc.toLowerCase().includes(q)
    );
  }, [q]);

  const filteredSteps = useMemo(() => {
    if (!q) return gettingStarted;
    return gettingStarted.filter(
      (s) => s.title.toLowerCase().includes(q) || s.desc.toLowerCase().includes(q)
    );
  }, [q]);

  const filteredFeatures = useMemo(() => {
    if (!q) return features;
    return features.filter(
      (f) => f.title.toLowerCase().includes(q) || f.desc.toLowerCase().includes(q)
    );
  }, [q]);

  const filteredPageAnchors = useMemo(() => {
    if (!q) return pageAnchors;
    return pageAnchors.filter(
      (p) => p.title.toLowerCase().includes(q) || p.desc.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)
    );
  }, [q]);

  const filteredActionTypes = useMemo(() => {
    if (!q) return ACTION_CATEGORIES.map((c) => ({ cat: c.label, types: c.types.join(", ") }));
    return ACTION_CATEGORIES
      .map((c) => ({ cat: c.label, types: c.types.join(", ") }))
      .filter((a) => a.cat.toLowerCase().includes(q) || a.types.toLowerCase().includes(q));
  }, [q]);

  return (
    <PageShell
      icon={HelpCircle}
      title="คู่มือการใช้งาน"
      subtitle="แนะนำการเริ่มต้น คำศัพท์ที่ใช้ในระบบ และฟีเจอร์หลัก"
    >
      {/* 🔒 P2c: Search box */}
      <div className="mb-6">
        <div className={`relative max-w-md transition-shadow ${searchFocused ? "ring-2 ring-brand/20" : ""}`}>
          <Search className="w-4 h-4 text-text-subtle absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            placeholder="ค้นหาคำศัพท์ ขั้นตอน ฟีเจอร์..."
            aria-label="ค้นหาในคู่มือ"
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-border bg-surface focus:outline-none focus:border-brand/40"
          />
        </div>
      </div>

      {/* Getting Started */}
      <section id="getting-started" className="mb-8 scroll-mt-20">
        <h2 className="text-base font-semibold text-text mb-3 flex items-center gap-2">
          <Zap size={16} className="text-brand" />
          เริ่มต้นใช้งาน
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filteredSteps.map((step, i) => {
            const Icon = step.icon;
            return (
              <Link
                key={i}
                href={step.link}
                className="group rounded-xl border border-border bg-surface p-4 hover:border-brand/30 hover:bg-surface-2 transition-colors"
              >
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 rounded-lg bg-brand/10 flex items-center justify-center">
                    <Icon size={16} className="text-brand" />
                  </div>
                  <h3 className="text-sm font-semibold text-text">{step.title}</h3>
                  <ArrowRight size={14} className="text-text-subtle ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
                <p className="text-xs text-text-muted leading-relaxed">{step.desc}</p>
              </Link>
            );
          })}
          {filteredSteps.length === 0 && (
            <p className="text-xs text-text-subtle col-span-full text-center py-4">ไม่พบขั้นตอนที่ตรงกับ "{search}"</p>
          )}
        </div>
      </section>

      {/* Features */}
      <section id="features" className="mb-8 scroll-mt-20">
        <h2 className="text-base font-semibold text-text mb-3 flex items-center gap-2">
          <Bot size={16} className="text-brand" />
          ฟีเจอร์หลัก
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filteredFeatures.map((f, i) => {
            const Icon = f.icon;
            return (
              <Link
                key={i}
                href={f.link}
                className="group rounded-xl border border-border bg-surface p-4 flex items-start gap-3 hover:border-brand/30 hover:bg-surface-2 transition-colors"
              >
                <div className="w-8 h-8 rounded-lg bg-surface-2 flex items-center justify-center shrink-0">
                  <Icon size={16} className="text-text-muted" />
                </div>
                <div className="flex-1">
                  <h3 className="text-sm font-semibold text-text mb-1">{f.title}</h3>
                  <p className="text-xs text-text-muted leading-relaxed">{f.desc}</p>
                </div>
                <ArrowRight size={14} className="text-text-subtle shrink-0 mt-1 opacity-0 group-hover:opacity-100 transition-opacity" />
              </Link>
            );
          })}
          {filteredFeatures.length === 0 && (
            <p className="text-xs text-text-subtle col-span-full text-center py-4">ไม่พบฟีเจอร์ที่ตรงกับ "{search}"</p>
          )}
        </div>
      </section>

      {/* Glossary */}
      <section id="glossary" className="mb-8 scroll-mt-20">
        <h2 className="text-base font-semibold text-text mb-3 flex items-center gap-2">
          <BookOpen size={16} className="text-brand" />
          คำศัพท์ (Glossary)
        </h2>
        <div className="rounded-xl border border-border bg-surface overflow-hidden">
          {filteredGlossary.map((g, i) => (
            <div
              key={i}
              className={`flex items-start gap-4 px-4 py-3 ${
                i < filteredGlossary.length - 1 ? "border-b border-border/50" : ""
              }`}
            >
              <div className="w-32 shrink-0">
                <div className="text-sm font-semibold text-text">{g.term}</div>
                <div className="text-[10px] text-text-subtle">{g.en}</div>
              </div>
              <p className="text-xs text-text-muted leading-relaxed flex-1">{g.desc}</p>
              {g.link && (
                <Link
                  href={g.link}
                  className="text-xs text-brand hover:text-brand-dark shrink-0 mt-0.5"
                  aria-label={`ไปที่หน้า ${g.term}`}
                >
                  ไปที่หน้า →
                </Link>
              )}
            </div>
          ))}
          {filteredGlossary.length === 0 && (
            <p className="text-xs text-text-subtle text-center py-4">ไม่พบคำศัพท์ที่ตรงกับ "{search}"</p>
          )}
        </div>
      </section>

      {/* Per-page help anchors */}
      <section className="mb-8">
        <h2 className="text-base font-semibold text-text mb-3 flex items-center gap-2">
          <BookOpen size={16} className="text-brand" />
          คู่มือแต่ละหน้า
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filteredPageAnchors.map((p) => (
            <div key={p.id} id={p.id} className="rounded-xl border border-border bg-surface p-4 scroll-mt-20">
              <div className="flex items-center justify-between mb-1">
                <h3 className="text-sm font-semibold text-text">{p.title}</h3>
                <Link href={p.link} className="text-xs text-brand hover:text-brand-dark">
                  ไปที่หน้า →
                </Link>
              </div>
              <p className="text-xs text-text-muted leading-relaxed">{p.desc}</p>
            </div>
          ))}
          {filteredPageAnchors.length === 0 && (
            <p className="text-xs text-text-subtle col-span-full text-center py-4">ไม่พบหน้าที่ตรงกับ "{search}"</p>
          )}
        </div>
      </section>

      {/* Action type reference (Logs) */}
      <section id="action-types" className="mb-8 scroll-mt-20">
        <h2 className="text-base font-semibold text-text mb-3 flex items-center gap-2">
          <BookOpen size={16} className="text-brand" />
          ประเภทการกระทำ (Action Types)
        </h2>
        <p className="text-xs text-text-muted mb-3">รหัส action_type ที่ใช้ในหน้า Logs — แสดงเป็นภาษาไทยในหน้า Logs แล้ว แต่นี่คือรหัสจริงสำหรับอ้างอิง <Link href="/logs" className="text-brand hover:text-brand-dark">ไปที่หน้า Logs →</Link></p>
        <div className="rounded-xl border border-border bg-surface overflow-hidden">
          {filteredActionTypes.map((row, i) => (
            <div key={row.cat} className={`flex items-start gap-4 px-4 py-2.5 ${i < filteredActionTypes.length - 1 ? "border-b border-border/50" : ""}`}>
              <div className="w-28 shrink-0 text-sm font-semibold text-text">{row.cat}</div>
              <code className="text-[11px] text-text-muted font-mono leading-relaxed flex-1">{row.types}</code>
            </div>
          ))}
          {filteredActionTypes.length === 0 && (
            <p className="text-xs text-text-subtle text-center py-4">ไม่พบ action type ที่ตรงกับ "{search}"</p>
          )}
        </div>
      </section>

      {/* Tips */}
      <section>
        <h2 className="text-base font-semibold text-text mb-3 flex items-center gap-2">
          <HelpCircle size={16} className="text-brand" />
          ทิปส์และคำแนะนำ
        </h2>
        <div className="rounded-xl border border-info/15 bg-info/5 p-4 space-y-2">
          <p className="text-xs text-text-muted leading-relaxed">
            <span className="text-info-dark font-medium">ลัดแป้นพิมพ์:</span> กด <kbd className="px-1.5 py-0.5 rounded border border-border bg-surface-2 text-[10px] font-mono">Ctrl+B</kbd> (หรือ <kbd className="px-1.5 py-0.5 rounded border border-border bg-surface-2 text-[10px] font-mono">⌘+B</kbd>) เพื่อย่อ/ขยาย Sidebar
          </p>
          <p className="text-xs text-text-muted leading-relaxed">
            <span className="text-info-dark font-medium">ค้นหาใน Sidebar:</span> พิมพ์ในช่องค้นหาด้านบน Sidebar เพื่อกรองเมนู
          </p>
          <p className="text-xs text-text-muted leading-relaxed">
            <span className="text-info-dark font-medium">ทดสอบก่อนใช้จริง:</span> ใช้ <Link href="/shadow-inbox" className="text-brand hover:text-brand-dark">Shadow Inbox</Link> ทดสอบบอทก่อนเปิดใช้งานจริง — คำตอบบอทไม่ส่งถึงลูกค้า
          </p>
          <p className="text-xs text-text-muted leading-relaxed">
            <span className="text-info-dark font-medium">เปรียบเทียบคุณภาพ:</span> ใช้ <Link href="/replay-compare" className="text-brand hover:text-brand-dark">Replay Compare</Link> เปรียบเทียบคำตอบบอทกับแอดมินเก่า เพื่อวัดและปรับปรุง
          </p>
        </div>
      </section>
    </PageShell>
  );
}
