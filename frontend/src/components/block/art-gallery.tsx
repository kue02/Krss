/**
 * obsidianui `art-gallery` 原件
 * —— https://www.obsidianui.dev/docs/art-gallery
 *
 * three.js + WebGL shader 的「透镜照片墙」：整块是一个全屏 shader 平面，
 * 每格贴图集里的一张照片，按住拖动平移，指针附近有轻微桶形畸变。
 *
 * 本项目改了 4 处（其余逐字照原件；见 `docs/dev/todo.md` §2.29 31-1）：
 *  1. **有限网格**：原件 `texIndex = mod(cellId.x + cellId.y*3, count)` 无限循环平铺，
 *     这里改成 cell → 线性唯一照片下标、超出张数的格画背景（同一张不会重复出现）；
 *  2. **偏移夹紧**：拖到网格边界就停（网格比视口小则居中），不会拖进空白区
 *     —— 原件不夹紧（无限循环，拖多远都有内容）；
 *  3. **图集按 cover 裁切**：原件把照片径直拉成正方形（会变形），这里短边铺满居中裁；
 *  4. **加载态与文案**：原件自带 `ripple-pulse-loader`，但它的 CSS 没随 registry 发出来，
 *     这里改用本仓既有的 `animate-spin` 圆环；提示文案走 `hint` 属性（调用方给 i18n）。
 *
 * `three` 只在开「照片墙」档时才加载（调用方 `React.lazy`），不进其它视图的首屏包。
 */
import {
  Component,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import * as THREE from "three";
import { cn } from "@/lib/utils";
import {
  clampWallOffset,
  wallAtlasSide,
  wallCoverCrop,
  wallGridLayout,
  wallGridWorld,
  wallViewWorld,
  WALL_TILE_PX,
} from "@/lib/picture-wall";

/** 原件的配色（逐字照抄） */
const WALL_COLORS = {
  borderColor: "rgba(255, 255, 255, 0.15)",
  backgroundColor: "rgba(0, 0, 0, 1)",
  textColor: "rgba(128, 128, 128, 1)",
  hoverColor: "rgba(255, 255, 255, 0)",
};

const VERTEX_SHADER = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/* 与原件 shader 的差异只在 cell 映射（有限网格 + 唯一下标）、网格线只在网格内画 */
const FRAGMENT_SHADER = `
  uniform vec2 uOffset;
  uniform vec2 uResolution;
  uniform vec4 uBorderColor;
  uniform vec4 uHoverColor;
  uniform vec4 uBackgroundColor;
  uniform vec2 uMousePos;
  uniform float uZoom;
  uniform float uCellSize;
  uniform vec2 uGridSize;
  uniform float uTextureCount;
  uniform sampler2D uImageAtlas;
  varying vec2 vUv;

  void main() {
    vec2 screenUV = (vUv - 0.5) * 2.0;
    float radius = length(screenUV);
    float distortion = 1.0 - 0.08 * radius * radius;
    vec2 distortedUV = screenUV * distortion;
    vec2 aspectRatio = vec2(uResolution.x / uResolution.y, 1.0);
    vec2 worldCoord = distortedUV * aspectRatio;
    worldCoord *= uZoom;
    worldCoord += uOffset;

    /* 网格居中于原点：世界原点 = 网格中心 */
    vec2 gridWorld = uGridSize * uCellSize;
    vec2 cellPos = (worldCoord + gridWorld * 0.5) / uCellSize;
    vec2 cellId = floor(cellPos);
    vec2 cellUV = fract(cellPos);

    bool inGrid = cellId.x >= 0.0 && cellId.y >= 0.0 &&
                  cellId.x < uGridSize.x && cellId.y < uGridSize.y;
    /* 唯一的照片下标：行优先线性映射（原件是 mod(...) 循环） */
    float cellIndex = cellId.y * uGridSize.x + cellId.x;
    bool hasPhoto = inGrid && cellIndex < uTextureCount;

    vec2 mouseScreenUV = (uMousePos / uResolution) * 2.0 - 1.0;
    mouseScreenUV.y = -mouseScreenUV.y;
    float mouseRadius = length(mouseScreenUV);
    float mouseDistortion = 1.0 - 0.08 * mouseRadius * mouseRadius;
    vec2 mouseDistortedUV = mouseScreenUV * mouseDistortion;
    vec2 mouseWorldCoord = mouseDistortedUV * aspectRatio;
    mouseWorldCoord *= uZoom;
    mouseWorldCoord += uOffset;
    vec2 mouseCellPos = (mouseWorldCoord + gridWorld * 0.5) / uCellSize;
    vec2 mouseCellId = floor(mouseCellPos);
    vec2 cellCenter = cellId + 0.5;
    vec2 mouseCellCenter = mouseCellId + 0.5;
    float cellDistance = length(cellCenter - mouseCellCenter);
    float hoverIntensity = 1.0 - smoothstep(0.4, 0.7, cellDistance);
    bool isHovered = hoverIntensity > 0.0 && uMousePos.x >= 0.0;

    vec3 backgroundColor = uBackgroundColor.rgb;
    if (isHovered) {
      backgroundColor = mix(uBackgroundColor.rgb, uHoverColor.rgb, hoverIntensity * uHoverColor.a);
    }

    vec3 color = backgroundColor;

    if (inGrid) {
      float lineWidth = 0.005;
      float gridX = smoothstep(0.0, lineWidth, cellUV.x) * smoothstep(0.0, lineWidth, 1.0 - cellUV.x);
      float gridY = smoothstep(0.0, lineWidth, cellUV.y) * smoothstep(0.0, lineWidth, 1.0 - cellUV.y);
      float gridMask = gridX * gridY;
      color = mix(color, uBorderColor.rgb, (1.0 - gridMask) * uBorderColor.a);
    }

    if (hasPhoto) {
      float imageSize = 0.6;
      float imageBorder = (1.0 - imageSize) * 0.5;
      vec2 imageUV = (cellUV - imageBorder) / imageSize;
      float edgeSmooth = 0.01;
      vec2 imageMask = smoothstep(-edgeSmooth, edgeSmooth, imageUV) *
                       smoothstep(-edgeSmooth, edgeSmooth, 1.0 - imageUV);
      float imageAlpha = imageMask.x * imageMask.y;
      bool inImageArea = imageUV.x >= 0.0 && imageUV.x <= 1.0 &&
                         imageUV.y >= 0.0 && imageUV.y <= 1.0;
      if (inImageArea && imageAlpha > 0.0) {
        float atlasSize = ceil(sqrt(uTextureCount));
        vec2 atlasPos = vec2(mod(cellIndex, atlasSize), floor(cellIndex / atlasSize));
        vec2 atlasUV = (atlasPos + imageUV) / atlasSize;
        atlasUV.y = 1.0 - atlasUV.y;
        vec3 imageColor = texture2D(uImageAtlas, atlasUV).rgb;
        color = mix(color, imageColor, imageAlpha);
      }
    }

    float fade = 1.0 - smoothstep(1.2, 1.8, radius);
    gl_FragColor = vec4(color * fade, 1.0);
  }
`;

function rgbaToArray(rgba: string): [number, number, number, number] {
  const match = rgba.match(/rgba?\(([^)]+)\)/);
  if (!match) return [1, 1, 1, 1];
  const parts = (match[1] ?? "").split(",");
  return [
    parseFloat(parts[0] ?? "0") / 255,
    parseFloat(parts[1] ?? "0") / 255,
    parseFloat(parts[2] ?? "0") / 255,
    parseFloat(parts[3] ?? "1"),
  ];
}

/** 载入一张图；失败返回 null（原件返回一张黑图，这里直接留空） */
function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    if (/^https?:\/\//.test(src)) image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

/**
 * 把照片合成一张图集（原件做法 + cover 裁切）。
 *
 * 注意内存：图集边长 = ceil(√张数) × 512px —— 120 张就是 5632² 画布（约 127MB 显存）。
 * 这是原件的硬限制，也是本项目把张数封顶在 `WALL_MAX_TILES` 的原因。
 */
async function buildAtlas(images: string[]): Promise<THREE.CanvasTexture> {
  const side = wallAtlasSide(images.length);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = side * WALL_TILE_PX;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const loaded = await Promise.all(images.map((src) => loadImage(src)));
    loaded.forEach((image, index) => {
      if (!image || !ctx) return;
      const crop = wallCoverCrop(image.naturalWidth, image.naturalHeight);
      if (!crop.sw || !crop.sh) return;
      const x = (index % side) * WALL_TILE_PX;
      const y = Math.floor(index / side) * WALL_TILE_PX;
      try {
        ctx.drawImage(
          image,
          crop.sx,
          crop.sy,
          crop.sw,
          crop.sh,
          x,
          y,
          WALL_TILE_PX,
          WALL_TILE_PX,
        );
      } catch {
        /* 单张画不进去就留黑格，不影响整面墙 */
      }
    });
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

const MOTION_QUERY = "(prefers-reduced-motion: reduce)";
/** jsdom / 老环境里没有 matchMedia ⇒ 当「没开减少动效」，不能让组件崩 */
const motionMedia = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(MOTION_QUERY)
    : null;

const subscribeReducedMotion = (notify: () => void) => {
  const query = motionMedia();
  if (!query) return () => {};
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
};

/** 原件的 `useEffectReducedMotion`（webgl-surface 里的那个 hook） */
function useWallReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => motionMedia()?.matches ?? false,
    () => false,
  );
}

let webglAvailable: boolean | undefined;
function supportsWebGL(): boolean {
  if (webglAvailable !== undefined) return webglAvailable;
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2");
    webglAvailable = Boolean(context);
    context?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    webglAvailable = false;
  }
  return webglAvailable;
}
const subscribeAvailability = () => () => {};

class SurfaceBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export interface ArtGalleryProps {
  /** 照片地址（同源/代理地址最好，跨域图会因 CORS 失败留黑格） */
  images: string[];
  /** 每格在世界坐标里的尺寸（原件 0.75） */
  cellSize?: number;
  /** 拖动时的放大倍率（原件 1.25） */
  zoomLevel?: number;
  /** 底部提示文案（i18n 由调用方给；不传则不显示） */
  hint?: string;
  /** 不支持 WebGL 时的降级说明文案 */
  unsupportedNote?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * 不支持 WebGL / shader 崩了时的降级：普通方格照片墙（CSS grid，不用 WebGL）
 * —— 用户要求「失败须给可见原因」，所以这里给一层说明文字。
 */
function WallFallback({
  images,
  note,
  className,
  style,
}: {
  images: string[];
  note?: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      data-art-gallery-fallback="true"
      className={cn("relative h-full w-full overflow-hidden bg-black", className)}
      style={style}
    >
      <div className="grid h-full w-full grid-cols-3 content-start gap-px overflow-auto sm:grid-cols-5 lg:grid-cols-6">
        {images.map((src) => (
          <img
            key={src}
            src={src}
            alt=""
            loading="lazy"
            className="aspect-square w-full object-cover opacity-80"
          />
        ))}
      </div>
      {note ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-[0.7rem] text-white/40">
          {note}
        </div>
      ) : null}
    </div>
  );
}

export function ArtGallery({
  images,
  cellSize = 0.75,
  zoomLevel = 1.25,
  hint,
  unsupportedNote,
  className,
  style,
}: ArtGalleryProps) {
  const reducedMotion = useWallReducedMotion();
  const supported = useSyncExternalStore(
    subscribeAvailability,
    supportsWebGL,
    () => false,
  );
  const fallback = (
    <WallFallback
      images={images}
      note={supported ? undefined : unsupportedNote}
      className={className}
      style={style}
    />
  );

  return (
    <div
      data-art-gallery="true"
      data-art-gallery-count={images.length}
      className={cn(
        "relative isolate h-full w-full overflow-hidden bg-black",
        className,
      )}
      style={style}
    >
      {supported ? (
        <SurfaceBoundary fallback={fallback}>
          <ArtGalleryScene
            images={images}
            cellSize={cellSize}
            zoomLevel={zoomLevel}
            hint={hint}
            reducedMotion={reducedMotion}
          />
        </SurfaceBoundary>
      ) : (
        fallback
      )}
    </div>
  );
}

function ArtGalleryScene({
  images,
  cellSize,
  zoomLevel,
  hint,
  reducedMotion,
}: {
  images: string[];
  cellSize: number;
  zoomLevel: number;
  hint?: string;
  reducedMotion: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // ready 只在 init 成功后置 true（不在 effect 体里同步 setState）。
    // 照片集变了要重来一遍的话，调用方给本组件传 `key` 重挂载即可。

    let cancelled = false;
    let animFrameId = 0;
    let plane: THREE.Mesh | undefined;
    let geometry: THREE.PlaneGeometry | undefined;
    let material: THREE.ShaderMaterial | undefined;
    let atlas: THREE.CanvasTexture | undefined;

    const containerAspect =
      container.clientHeight > 0
        ? container.clientWidth / container.clientHeight
        : 1.6;
    const grid = wallGridLayout(images.length, containerAspect);
    const gridWorld = wallGridWorld(grid, cellSize);

    const state = {
      isDragging: false,
      previousPointer: { x: 0, y: 0 },
      offset: { x: 0, y: 0 },
      targetOffset: { x: 0, y: 0 },
      mousePosition: { x: -1, y: -1 },
      zoom: 1,
      targetZoom: 1,
    };

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 1;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const bg = rgbaToArray(WALL_COLORS.backgroundColor);
    renderer.setClearColor(new THREE.Color(bg[0], bg[1], bg[2]), bg[3]);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.touchAction = "none";
    container.appendChild(renderer.domElement);

    const lerpFactor = reducedMotion ? 1 : 0.075;
    const dragZoom = reducedMotion ? 1 : zoomLevel;

    /** 每帧把目标偏移夹回网格范围（缩放变大时可用范围会变小，必须每帧夹） */
    const clampTarget = () => {
      const view = wallViewWorld(
        container.clientWidth,
        container.clientHeight,
        state.targetZoom,
      );
      const clamped = clampWallOffset(state.targetOffset, gridWorld, view);
      state.targetOffset.x = clamped.x;
      state.targetOffset.y = clamped.y;
    };

    let lastOffsetAttr = "";
    const animate = () => {
      animFrameId = requestAnimationFrame(animate);
      clampTarget();
      state.offset.x += (state.targetOffset.x - state.offset.x) * lerpFactor;
      state.offset.y += (state.targetOffset.y - state.offset.y) * lerpFactor;
      state.zoom += (state.targetZoom - state.zoom) * lerpFactor;
      const uniforms = (
        plane as THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | undefined
      )?.material.uniforms;
      if (uniforms?.uOffset) {
        uniforms.uOffset.value.set(state.offset.x, state.offset.y);
      }
      if (uniforms?.uZoom) uniforms.uZoom.value = state.zoom;
      /* 真机/单测读数用：当前偏移镜像到 data 属性（值没变就不写） */
      const attr = `${Math.round(state.offset.x * 1000)},${Math.round(state.offset.y * 1000)},${state.zoom.toFixed(3)}`;
      if (attr !== lastOffsetAttr) {
        lastOffsetAttr = attr;
        container.dataset.artOffset = attr;
      }
      renderer.render(scene, camera);
    };

    const updateMousePosition = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      state.mousePosition.x = event.clientX - rect.left;
      state.mousePosition.y = event.clientY - rect.top;
      const uniforms = (
        plane as THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | undefined
      )?.material.uniforms;
      uniforms?.uMousePos?.value.set(state.mousePosition.x, state.mousePosition.y);
    };

    const startDrag = (x: number, y: number) => {
      state.isDragging = true;
      state.previousPointer.x = x;
      state.previousPointer.y = y;
    };

    const handleMove = (x: number, y: number) => {
      if (!state.isDragging) return;
      const deltaX = x - state.previousPointer.x;
      const deltaY = y - state.previousPointer.y;
      if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) {
        if (state.targetZoom === 1) state.targetZoom = dragZoom;
      }
      state.targetOffset.x -= deltaX * 0.003;
      state.targetOffset.y += deltaY * 0.003;
      state.previousPointer.x = x;
      state.previousPointer.y = y;
    };

    const endDrag = () => {
      state.isDragging = false;
      state.targetZoom = 1;
    };

    const onPointerDown = (event: PointerEvent) => {
      event.preventDefault();
      container.setPointerCapture?.(event.pointerId);
      startDrag(event.clientX, event.clientY);
    };
    const onPointerMove = (event: PointerEvent) => {
      updateMousePosition(event);
      handleMove(event.clientX, event.clientY);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (container.hasPointerCapture?.(event.pointerId)) {
        container.releasePointerCapture(event.pointerId);
      }
      endDrag();
    };
    const onPointerLeave = () => {
      state.mousePosition.x = state.mousePosition.y = -1;
      const uniforms = (
        plane as THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | undefined
      )?.material.uniforms;
      uniforms?.uMousePos?.value.set(-1, -1);
      endDrag();
    };
    const onResize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (!width || !height) return;
      renderer.setSize(width, height);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      const uniforms = (
        plane as THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | undefined
      )?.material.uniforms;
      uniforms?.uResolution?.value.set(width, height);
      clampTarget();
    };

    const init = async () => {
      atlas = await buildAtlas(images);
      if (cancelled) return;

      const uniforms = {
        uOffset: { value: new THREE.Vector2(0, 0) },
        uResolution: {
          value: new THREE.Vector2(
            container.clientWidth,
            container.clientHeight,
          ),
        },
        uBorderColor: { value: new THREE.Vector4(...rgbaToArray(WALL_COLORS.borderColor)) },
        uHoverColor: { value: new THREE.Vector4(...rgbaToArray(WALL_COLORS.hoverColor)) },
        uBackgroundColor: {
          value: new THREE.Vector4(...rgbaToArray(WALL_COLORS.backgroundColor)),
        },
        uMousePos: { value: new THREE.Vector2(-1, -1) },
        uZoom: { value: 1 },
        uCellSize: { value: cellSize },
        uGridSize: { value: new THREE.Vector2(grid.cols, grid.rows) },
        uTextureCount: { value: images.length },
        uImageAtlas: { value: atlas },
      };

      geometry = new THREE.PlaneGeometry(2, 2);
      material = new THREE.ShaderMaterial({
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        uniforms,
      });
      plane = new THREE.Mesh(geometry, material);
      scene.add(plane);

      container.addEventListener("pointerdown", onPointerDown);
      container.addEventListener("pointermove", onPointerMove);
      container.addEventListener("pointerup", onPointerUp);
      container.addEventListener("pointercancel", onPointerUp);
      container.addEventListener("pointerleave", onPointerLeave);
      window.addEventListener("resize", onResize);
      animate();
      setReady(true);
    };

    void init();

    return () => {
      cancelled = true;
      cancelAnimationFrame(animFrameId);
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerup", onPointerUp);
      container.removeEventListener("pointercancel", onPointerUp);
      container.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("resize", onResize);
      atlas?.dispose();
      geometry?.dispose();
      material?.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
    // images 数组内容变了才重建（调用方用 useMemo 稳定引用）
  }, [images, cellSize, zoomLevel, reducedMotion]);

  return (
    <div className="absolute inset-0 cursor-grab active:cursor-grabbing">
      <div
        ref={containerRef}
        data-art-gallery-scene="true"
        data-art-gallery-ready={ready ? "true" : "false"}
        className="absolute inset-0"
        style={{ opacity: ready ? 1 : 0 }}
      />
      {!ready ? (
        <div
          data-art-gallery-loading="true"
          role="status"
          aria-live="polite"
          className="absolute inset-0 z-20 flex items-center justify-center bg-black"
        >
          <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : null}
      {ready && hint ? (
        <div className="pointer-events-none absolute bottom-6 left-1/2 z-10 -translate-x-1/2 font-mono text-[0.6rem] uppercase tracking-[0.2em] text-white/20">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

export default ArtGallery;
