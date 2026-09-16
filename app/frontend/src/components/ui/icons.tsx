import { cn } from "@/lib/utils";

interface IconProps {
  className?: string;
}

export function ArrowDownAZIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m3 8 4-4 4 4" />
      <path d="M7 4v16" />
      <path d="M11 12h4" />
      <path d="M11 16h7" />
      <path d="M11 20h10" />
    </svg>
  );
}

export function CalendarIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path d="M3 10h18" />
    </svg>
  );
}

// ============================================================================
// 四个内容类型的图标（文章 / 图片 / 通知 / 社交媒体）
//
// 设计约定（这套是自定义的，不用通用图标库那几张脸）：
//   · 同一个 24 网格、描边 1.7、圆头圆角，视觉重量一致
//   · 文章/图片用「圆角卡片 + 实心细节」——和界面本身的卡片列表呼应
//   · 通知/社交媒体是同类语汇的轮廓 + 实心点，四个摆在一起是一家人
// 尺寸小到 16px 也要能认出来，所以只留最少的笔划。
// ============================================================================

export function FileTextIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* 卡片轮廓，和列表卡片同形 */}
      <rect x="3" y="3" width="18" height="18" rx="4.5" />
      {/* 三行文字，由长到短 */}
      <path d="M7.6 8.9h8.8" strokeWidth={2} />
      <path d="M7.6 12.6h6.4" strokeWidth={2} />
      <path d="M7.6 16.3h4" strokeWidth={2} />
    </svg>
  );
}

export function ImageIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="18" height="18" rx="4.5" />
      {/* 太阳（实心点）+ 山峰 */}
      <circle cx="9" cy="9.4" r="1.5" fill="currentColor" stroke="none" />
      <path d="M4.6 17.4l4.1-4.3a1.7 1.7 0 0 1 2.5 0l4.2 4.3" />
      <path d="M14.1 15.5l1.4-1.4a1.7 1.7 0 0 1 2.4 0l1.5 1.5" />
    </svg>
  );
}

export function BellIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* 钟身：底边收平，顶上是圆头 */}
      <path d="M12 3.4a5.6 5.6 0 0 1 5.6 5.6v3.5l1.2 2.4H5.2l1.2-2.4V9A5.6 5.6 0 0 1 12 3.4z" />
      {/* 铃舌（实心点） */}
      <circle cx="12" cy="18.6" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function SocialIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* 对话气泡（左下带小尾巴） */}
      <path d="M20.4 11.4c0 4-3.7 7.2-8.3 7.2-1 0-2-.2-2.9-.5l-4.1 1.8 1.4-3.6a6.9 6.9 0 0 1-1.9-4.9C4.6 7.4 8.3 4.2 12.9 4.2s7.5 3.2 7.5 7.2z" />
      {/* 正在说话的三点 */}
      <circle cx="9.3" cy="11.4" r="1" fill="currentColor" stroke="none" />
      <circle cx="12.7" cy="11.4" r="1" fill="currentColor" stroke="none" />
      <circle cx="16.1" cy="11.4" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function BackIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
    </svg>
  );
}

export function CircleOutlineIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <circle cx="12" cy="12" r="8" />
    </svg>
  );
}

export function CircleFilledIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="12" r="8" />
    </svg>
  );
}

export function CheckCircleIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

export function MenuIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 6h16M4 12h16M4 18h16"
      />
    </svg>
  );
}

export function AddIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function RssIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 11a9 9 0 0 1 9 9" />
      <path d="M4 4a16 16 0 0 1 16 16" />
      <circle cx="5" cy="19" r="1" />
    </svg>
  );
}

export function ErrorIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z" />
    </svg>
  );
}

export function ChevronIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

export function StarIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </svg>
  );
}

export function UserIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
      />
    </svg>
  );
}

export function ClockIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

export function GripVerticalIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="9" cy="12" r="1" />
      <circle cx="9" cy="5" r="1" />
      <circle cx="9" cy="19" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="15" cy="5" r="1" />
      <circle cx="15" cy="19" r="1" />
    </svg>
  );
}

export function GlobeIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z" />
    </svg>
  );
}

export function RefreshIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  );
}

const REFRESH_RING_RADIUS = 9;
const REFRESH_RING_CIRCUMFERENCE = 2 * Math.PI * REFRESH_RING_RADIUS;

/**
 * 刷新中的按钮图标：一圈持续转动的弧，圈内显示还剩多少个源没刷完。
 * 用在列表头 / 订阅设置页的刷新按钮上。
 */
export function RefreshSpinner({
  remaining,
  className,
}: {
  remaining: number;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "relative flex size-7 items-center justify-center",
        className,
      )}
    >
      <svg
        viewBox="0 0 24 24"
        className="absolute inset-0 size-7 animate-spin"
        fill="none"
        aria-hidden="true"
      >
        <circle
          cx="12"
          cy="12"
          r={REFRESH_RING_RADIUS}
          strokeWidth={2.5}
          className="stroke-current opacity-15"
        />
        <circle
          cx="12"
          cy="12"
          r={REFRESH_RING_RADIUS}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray={`${REFRESH_RING_CIRCUMFERENCE * 0.7} ${REFRESH_RING_CIRCUMFERENCE * 0.3}`}
          className="stroke-primary"
        />
      </svg>
      <span className="relative text-[10px] font-bold leading-none tabular-nums">
        {remaining}
      </span>
    </span>
  );
}

export function EyeOffIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
      <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
      <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
      <path d="m2 2 20 20" />
    </svg>
  );
}
