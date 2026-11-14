// Workflow editor page — server component รับ params (Next 16: params เป็น Promise)
// แล้ว render client editor (canvas builder แบบ Zaapi)
// workflowId = "new" (สร้างใหม่) หรือ id จริง (แก้ของเดิม)
import WorkflowEditor from "@/components/workflow/WorkflowEditor";

export default async function WorkflowEditorPage({
  params,
}: {
  params: Promise<{ workflowId: string }>;
}) {
  const { workflowId } = await params;
  return (
    <div
      className="workflow-page-shell min-h-0 min-w-0 flex flex-col overflow-hidden"
      style={{ height: "calc(var(--app-vh, 100dvh) - 52px)" }}
    >
      <WorkflowEditor workflowId={workflowId} />
    </div>
  );
}
