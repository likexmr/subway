/* ============================================================
   지도 — SVG 노선도 렌더링 & 부드러운 카메라 이동
   ============================================================ */

const SubwayMap = (() => {
  const NS = "http://www.w3.org/2000/svg";
  let svg, gLines, gStations, gLabels, focusRing;
  let network = null;
  let view = { x: 0, y: 0, w: 2400, h: 1600 };
  let animFrame = null;

  function el(tag, attrs = {}) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  function init(container) {
    container.innerHTML = "";
    svg = el("svg", { id: "metro-svg" });
    gLines = el("g", { class: "g-lines" });
    gStations = el("g", { class: "g-stations" });
    gLabels = el("g", { class: "g-labels" });
    focusRing = el("circle", { class: "focus-ring", r: 16, opacity: 0 });
    svg.append(gLines, gStations, gLabels, focusRing);
    container.appendChild(svg);
  }

  function render(net) {
    network = net;
    gLines.innerHTML = "";
    gStations.innerHTML = "";
    gLabels.innerHTML = "";

    // 노선 그리기 — 구간(edge) 단위
    // 한 구간을 여러 노선이 공유하면 각 노선 색을 진행방향에 수직으로
    // 나란히(위 반/아래 반) 그려 두 색이 모두 보이게 한다.
    // 또 via(우회 중간점)가 있으면 직선 대신 둥근 폴리라인으로 그린다.
    const LINE_W = 8;

    // 점 배열을 받아 진행방향 수직으로 off만큼 평행이동
    const offsetPts = (pts, off) => {
      if (off === 0) return pts.map(p => [...p]);
      return pts.map((p, i) => {
        const prev = pts[Math.max(0, i - 1)];
        const next = pts[Math.min(pts.length - 1, i + 1)];
        const dx = next[0] - prev[0], dy = next[1] - prev[1];
        const len = Math.hypot(dx, dy) || 1;
        return [p[0] + (-dy / len) * off, p[1] + (dx / len) * off];
      });
    };
    // 점 배열 → 둥근 모서리 path d
    const roundedD = (pts, radius = 14) => {
      const f = p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
      const v = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 0.5);
      if (v.length < 2) return "";
      if (v.length === 2) return `M${f(v[0])} L${f(v[1])}`;
      let d = `M${f(v[0])}`;
      for (let i = 1; i < v.length - 1; i++) {
        const p = v[i - 1], c = v[i], n = v[i + 1];
        const din = Math.hypot(c[0] - p[0], c[1] - p[1]) || 1;
        const dout = Math.hypot(n[0] - c[0], n[1] - c[1]) || 1;
        const rin = Math.min(radius, din / 2), rout = Math.min(radius, dout / 2);
        const a = [c[0] - (c[0] - p[0]) / din * rin, c[1] - (c[1] - p[1]) / din * rin];
        const b = [c[0] + (n[0] - c[0]) / dout * rout, c[1] + (n[1] - c[1]) / dout * rout];
        d += ` L${f(a)} Q${f(c)} ${f(b)}`;
      }
      d += ` L${f(v[v.length - 1])}`;
      return d;
    };

    if (net.edges) {
      for (const e of net.edges) {
        // 경로 기준점: 시작 → (via들) → 끝
        const base = [[e.ax, e.ay], ...(e.via || []), [e.bx, e.by]];
        const n = e.lines.length;
        const w = n > 1 ? LINE_W * 0.62 : LINE_W;
        const gap = w;
        const span = (n - 1) * gap;
        e.lines.forEach((id, i) => {
          const off = i * gap - span / 2;
          const pts = offsetPts(base, off);
          gLines.appendChild(el("path", {
            d: roundedD(pts),
            fill: "none", stroke: lineById(id).color,
            "stroke-width": w, "stroke-linecap": "round", "stroke-linejoin": "round",
            class: "line-path"
          }));
        });
      }
    } else {
      // 폴백: 기존 폴리라인 방식
      for (const { line, points } of net.paths) {
        const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
        gLines.appendChild(el("path", {
          d, fill: "none", stroke: line.color,
          "stroke-width": LINE_W, "stroke-linecap": "round", "stroke-linejoin": "round",
          class: "line-path"
        }));
      }
    }

    // 역 + 이름 라벨
    for (const st of net.stations.values()) {
      const isTransfer = st.lines.length > 1;
      const color = lineById(st.lines[0]).color;
      const c = el("circle", {
        cx: st.x, cy: st.y,
        r: isTransfer ? 9 : 6,
        fill: "#ffffff",
        stroke: isTransfer ? "#23262b" : color,
        "stroke-width": isTransfer ? 3.5 : 3,
        class: "station-dot",
        "data-key": st.key
      });
      gStations.appendChild(c);

      const label = el("text", {
        x: st.x, y: st.y + (isTransfer ? 26 : 22),
        class: "station-label",
        "text-anchor": "middle",
        "data-key": st.key
      });
      label.textContent = st.name;
      gLabels.appendChild(label);
    }

    fitAll(true);
  }

  function aspect() {
    const r = svg.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r.width / r.height : 16 / 10;
  }

  function applyView() {
    svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
  }

  function fitAll(instant = false) {
    const b = network.bounds;
    const pad = 80;
    let w = (b.maxX - b.minX) + pad * 2;
    let h = (b.maxY - b.minY) + pad * 2;
    const a = aspect();
    if (w / h < a) w = h * a; else h = w / a;
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    const target = { x: cx - w / 2, y: cy - h / 2, w, h };
    instant ? jumpTo(target) : animateTo(target, 900);
  }

  function jumpTo(t) {
    cancelAnimationFrame(animFrame);
    view = { ...t };
    applyView();
  }

  // 부드러운 카메라 이동 (ease-in-out)
  function animateTo(t, duration = 750) {
    cancelAnimationFrame(animFrame);
    const from = { ...view };
    const start = performance.now();
    const ease = x => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    const step = now => {
      const p = Math.min(1, (now - start) / duration);
      const e = ease(p);
      view = {
        x: from.x + (t.x - from.x) * e,
        y: from.y + (t.y - from.y) * e,
        w: from.w + (t.w - from.w) * e,
        h: from.h + (t.h - from.h) * e
      };
      applyView();
      if (p < 1) animFrame = requestAnimationFrame(step);
    };
    animFrame = requestAnimationFrame(step);
  }

  // 특정 역으로 줌인
  function focusStation(key, zoomWidth = 1000) {
    const st = network.stations.get(key);
    if (!st) return;
    const a = aspect();
    const w = zoomWidth, h = zoomWidth / a;
    animateTo({ x: st.x - w / 2, y: st.y - h / 2 + h * 0.06, w, h }, 850);

    focusRing.setAttribute("cx", st.x);
    focusRing.setAttribute("cy", st.y);
    focusRing.setAttribute("opacity", 1);
    focusRing.classList.remove("pulse");
    void focusRing.getBoundingClientRect(); // 애니메이션 재시작
    focusRing.classList.add("pulse");
  }

  function revealLabel(key, correct) {
    const label = gLabels.querySelector(`text[data-key="${CSS.escape(key)}"]`);
    const dot = gStations.querySelector(`circle[data-key="${CSS.escape(key)}"]`);
    if (label) label.classList.add("revealed");
    if (dot) {
      dot.classList.remove("flash-correct", "flash-wrong");
      void dot.getBoundingClientRect();
      dot.classList.add(correct ? "flash-correct" : "flash-wrong");
    }
  }

  function hideFocus() {
    focusRing.setAttribute("opacity", 0);
    focusRing.classList.remove("pulse");
  }

  function handleResize() {
    if (network) applyView();
  }

  return { init, render, fitAll, focusStation, revealLabel, hideFocus, handleResize };
})();
