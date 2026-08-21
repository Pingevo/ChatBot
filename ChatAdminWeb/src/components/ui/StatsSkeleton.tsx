"use client";
// StatsSkeleton — skeleton loading สำหรับหน้า stats ทั้งหมด
// แทนการ unmount/remount ทั้งหน้า ทำให้ไม่กระพริบ

export function DashboardSkeleton() {
  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 animate-pulse">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="h-6 w-32 bg-surface-2 rounded mb-2" />
          <div className="h-4 w-48 bg-surface-2 rounded" />
        </div>
        <div className="h-9 w-64 bg-surface-2 rounded-lg" />
      </div>
      {/* KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="bg-surface border border-border rounded-xl p-4">
            <div className="flex justify-between mb-2">
              <div className="h-3 w-20 bg-surface-2 rounded" />
              <div className="h-4 w-4 bg-surface-2 rounded" />
            </div>
            <div className="h-7 w-16 bg-surface-2 rounded" />
          </div>
        ))}
      </div>
      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="bg-surface border border-border rounded-xl p-4 h-48">
            <div className="h-4 w-32 bg-surface-2 rounded mb-3" />
            <div className="h-32 w-full bg-surface-2 rounded" />
          </div>
        ))}
      </div>
      {/* Topic */}
      <div className="bg-surface border border-border rounded-xl p-4 h-24">
        <div className="h-4 w-24 bg-surface-2 rounded mb-3" />
        <div className="flex gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-7 w-24 bg-surface-2 rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function AnalyticsSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="h-6 w-40 bg-surface-2 rounded" />
        <div className="h-9 w-64 bg-surface-2 rounded-lg" />
      </div>
      {/* Channel header */}
      <div className="h-12 w-full bg-surface-2 rounded-xl" />
      {/* KPI grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="bg-surface border border-border rounded-xl p-4 h-32">
            <div className="h-3 w-32 bg-surface-2 rounded mb-3" />
            <div className="h-8 w-20 bg-surface-2 rounded mb-2" />
            <div className="h-16 w-full bg-surface-2 rounded" />
          </div>
        ))}
      </div>
      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-surface border border-border rounded-xl p-4 h-48">
            <div className="h-4 w-40 bg-surface-2 rounded mb-3" />
            <div className="h-32 w-full bg-surface-2 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function LiveSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="flex items-center justify-between">
        <div className="h-6 w-32 bg-surface-2 rounded" />
        <div className="h-9 w-80 bg-surface-2 rounded-lg" />
      </div>
      <div className="h-4 w-48 bg-surface-2 rounded" />
      <div className="h-12 w-full bg-surface-2 rounded-xl" />
      {/* Big stat cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="bg-surface border border-border rounded-xl p-5 h-28">
            <div className="h-3 w-32 bg-surface-2 rounded mb-3" />
            <div className="h-8 w-16 bg-surface-2 rounded mb-2" />
            <div className="h-3 w-24 bg-surface-2 rounded" />
          </div>
        ))}
      </div>
      {/* Closed */}
      <div className="bg-surface border border-border rounded-xl p-5 h-24">
        <div className="h-3 w-32 bg-surface-2 rounded mb-3" />
        <div className="h-8 w-16 bg-surface-2 rounded" />
      </div>
      {/* Panels */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="bg-surface border border-border rounded-xl p-5 h-64">
            <div className="h-4 w-40 bg-surface-2 rounded mb-4" />
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, j) => (
                <div key={j} className="h-6 w-full bg-surface-2 rounded" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
