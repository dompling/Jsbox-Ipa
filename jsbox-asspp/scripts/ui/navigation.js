// 使用画布内的普通视图绘制顶部栏；各页 navBarHidden 统一隐藏宿主播放/关闭。
// 账号头像不进入 UIBarButtonItem，尺寸不再受系统导航按钮的固有宽度影响。
const common = require("./common");
const C = common.colors;
const HEIGHT = 44;
let sequence = 0;

function accountButton(account, region, handler, label) {
  return {
    kind: "account", title: label || "切换账号", symbol: "person.crop.circle.fill",
    email: String(account && account.email || "").trim(),
    region: String(region || "").toUpperCase(), handler,
  };
}

function nativeValue(value) {
  if (value && typeof value.ocValue === "function") return value.ocValue();
  return value && typeof value.invoke === "function" ? value : null;
}

// 保留原有手势 delegate，只在本脚本子页稳定出现时尝试启用系统返回手势。
// 隐藏导航栏后的识别行为仍由宿主决定；返回按钮始终使用文档支持的 $ui.pop。
function enableSwipeBack() {
  try {
    const controller = nativeValue($ui.controller);
    if (!controller) return;
    const nav = controller.invoke("navigationController");
    if (!nav) return;
    const top = nav.invoke("topViewController");
    if (!top || !top.invoke("isEqual:", controller)) return;
    if (Number(nav.invoke("viewControllers").invoke("count")) < 2 || controller.invoke("transitionCoordinator")) return;
    const gesture = nav.invoke("interactivePopGestureRecognizer");
    if (gesture) gesture.invoke("setEnabled:", true);
  } catch (_err) {}
}

function create(options) {
  const opts = options || {}, props = opts.props || {};
  const readTitle = opts.title || (() => props.title || "");
  const readButtons = opts.buttons || (() => props.navButtons || []);
  const suffix = ++sequence, id = `navigation-bar-${suffix}`;
  let bar = null, actions = null, heading = null;
  let entries = new Map(), rightWidth = 0;
  let visible = false, disposed = false, popping = false;

  function updateButton(entry) {
    if (!entry.view) return;
    const descriptor = entry.descriptor;
    const target = entry.view.get(`${entry.id}-hit`);
    if (target) {
      target.accessibilityLabel = descriptor.title || "切换账号";
      target.accessibilityHint = descriptor.kind === "account" ? "选择 Apple ID 和对应商店区域" : "";
      target.accessibilityValue = descriptor.kind === "account"
        ? (descriptor.email ? `${descriptor.email} · ${descriptor.region}` : "未选择账号") : "";
    }
    const icon = entry.view.get(`${entry.id}-icon`), label = entry.view.get(`${entry.id}-label`);
    if (descriptor.kind === "account") {
      if (icon) icon.hidden = !!descriptor.email;
      if (label) {
        label.hidden = !descriptor.email;
        label.text = descriptor.email ? Array.from(descriptor.email)[0].toUpperCase() : "";
      }
    } else {
      const hasImage = !!(descriptor.symbol || descriptor.image);
      if (icon) {
        icon.hidden = !hasImage;
        if (descriptor.symbol) icon.symbol = descriptor.symbol;
        else if (descriptor.image) icon.image = descriptor.image;
      }
      if (label) { label.hidden = hasImage; label.text = descriptor.title || ""; }
    }
  }

  function buttonDefinition(entry) {
    const account = entry.descriptor.kind === "account";
    const foreground = account ? $color("white") : C.blue;
    const artwork = [
      {
        type: "image",
        props: { id: `${entry.id}-icon`, symbol: account ? "person.crop.circle.fill" : entry.descriptor.symbol, tintColor: foreground, userInteractionEnabled: false, isAccessibilityElement: false },
        layout: (make, view) => { make.center.equalTo(view.super); make.size.equalTo($size(22, 22)); },
      },
      {
        type: "label",
        props: { id: `${entry.id}-label`, font: account ? $font("bold", 15) : $font(16), textColor: foreground, align: $align.center, lines: 1, userInteractionEnabled: false, isAccessibilityElement: false },
        layout: $layout.fill,
      },
    ];
    return {
      type: "view",
      props: { id: entry.id, bgcolor: $color("clear"), clipsToBounds: false, isAccessibilityElement: false },
      layout: make => {
        make.right.inset(entry.offset);
        make.top.bottom.inset(0);
        make.width.equalTo(entry.width);
        make.height.equalTo(HEIGHT);
      },
      views: (account ? [{
        type: "view",
        props: { bgcolor: C.blue, cornerRadius: 17, circular: true, smoothCorners: false, clipsToBounds: true, userInteractionEnabled: false, isAccessibilityElement: false },
        layout: (make, view) => { make.center.equalTo(view.super); make.size.equalTo($size(34, 34)); },
        views: artwork,
      }] : artwork).concat([{
        type: "button",
        props: { id: `${entry.id}-hit`, title: "", bgcolor: $color("clear"), cornerRadius: 0, isAccessibilityElement: true, accessibilityLabel: entry.descriptor.title },
        layout: $layout.fill,
        events: { tapped: sender => {
          if (visible && !disposed && entry.active && typeof entry.descriptor.handler === "function") return entry.descriptor.handler(sender);
        } },
      }]),
      events: { ready: sender => { if (!disposed) { entry.view = sender; updateButton(entry); } } },
    };
  }

  function descriptors() { return (readButtons() || []).filter(Boolean); }
  function newEntry(descriptor, index, offset) {
    return {
      id: `${id}-action-${descriptor.kind || "action"}-${index}`,
      descriptor, offset, active: true, view: null,
      width: descriptor.kind === "account" || descriptor.symbol || descriptor.image ? 44
        : Math.max(44, String(descriptor.title || "").length * 16 + 12),
    };
  }

  function refresh() {
    if (disposed || !visible || !bar) return false;
    heading.text = String(readTitle() || "");
    heading.accessibilityLabel = heading.text;
    const next = new Map();
    let offset = 0;
    descriptors().forEach((descriptor, index) => {
      const key = `${descriptor.kind || "action"}:${index}`;
      let entry = entries.get(key);
      if (!entry) {
        entry = newEntry(descriptor, index, offset);
        actions.add(buttonDefinition(entry));
      }
      entry.descriptor = descriptor;
      entry.offset = offset;
      entry.active = true;
      if (entry.view && typeof entry.view.updateLayout === "function") {
        entry.view.updateLayout(make => make.right.inset(entry.offset));
      }
      updateButton(entry);
      next.set(key, entry);
      offset += entry.width + 8;
    });
    for (const [key, entry] of entries) if (!next.has(key)) {
      entry.active = false;
      if (entry.view) entry.view.remove();
    }
    entries = next;
    rightWidth = Math.max(0, offset - 8);
    if (typeof actions.updateLayout === "function") actions.updateLayout(make => make.width.equalTo(rightWidth));
    if (typeof heading.updateLayout === "function") heading.updateLayout(make => make.left.right.inset(Math.max(64, rightWidth + 20)));
    return true;
  }

  function headerDefinition() {
    const buttons = [];
    let offset = 0;
    descriptors().forEach((descriptor, index) => {
      const entry = newEntry(descriptor, index, offset);
      entries.set(`${descriptor.kind || "action"}:${index}`, entry);
      buttons.push(buttonDefinition(entry));
      offset += entry.width + 8;
    });
    rightWidth = Math.max(0, offset - 8);
    return {
      type: "view",
      props: { id, bgcolor: $color("clear"), clipsToBounds: false },
      layout: (make, view) => {
        make.top.left.right.equalTo(view.super.safeArea);
        make.height.equalTo(HEIGHT);
      },
      views: [{
        type: "blur",
        props: { id: `${id}-blur`, style: 8, userInteractionEnabled: false, isAccessibilityElement: false },
        layout: $layout.fill,
      }].concat(opts.root ? [] : [{
        type: "button",
        props: { id: `${id}-back`, title: "", bgcolor: $color("clear"), accessibilityLabel: "返回", isAccessibilityElement: true },
        layout: make => { make.left.inset(8); make.top.bottom.inset(0); make.width.equalTo(44); },
        views: [{
          type: "image",
          props: { symbol: "chevron.left", tintColor: C.blue, userInteractionEnabled: false },
          layout: (make, view) => { make.center.equalTo(view.super); make.size.equalTo($size(14, 22)); },
        }],
        events: { tapped: () => {
          if (!visible || disposed || popping) return;
          popping = true;
          try { $ui.pop(); } catch (err) { popping = false; common.alertError(err); }
        } },
      }]).concat([
        {
          type: "label",
          props: { id: `${id}-title`, text: String(readTitle() || ""), font: $font("bold", 17), textColor: props.titleColor || C.label, align: $align.center, lines: 1, userInteractionEnabled: false },
          layout: make => { make.top.bottom.inset(0); make.left.right.inset(Math.max(64, rightWidth + 20)); },
        },
        {
          type: "view", props: { id: `${id}-actions`, bgcolor: $color("clear"), clipsToBounds: false },
          layout: make => { make.right.inset(12); make.top.bottom.inset(0); make.width.equalTo(rightWidth); },
          views: buttons,
        },
      ]),
      events: { ready: sender => {
        if (disposed) return;
        bar = sender;
        heading = sender.get(`${id}-title`);
        actions = sender.get(`${id}-actions`);
        refresh();
      } },
    };
  }

  function attach() {
    if (disposed) return false;
    visible = true;
    popping = false;
    const attached = refresh();
    if (attached && !opts.root) enableSwipeBack();
    return attached;
  }

  function dispose() {
    disposed = true;
    visible = false;
    for (const entry of entries.values()) { entry.active = false; entry.view = null; }
    entries.clear();
    bar = actions = heading = null;
  }

  return {
    attach, refresh, hide: () => { visible = false; }, dispose,
    views: content => [{
      type: "view",
      props: { id: `navigation-content-${suffix}`, bgcolor: props.bgcolor || C.page, clipsToBounds: true },
      layout: (make, view) => {
        make.top.equalTo(view.super.safeArea).offset(HEIGHT);
        make.left.right.equalTo(view.super.safeArea);
        make.bottom.equalTo(view.super);
      },
      views: content,
    }, headerDefinition()],
  };
}

function page(definition, binding) {
  const navigation = binding || create({ props: definition.props });
  const events = definition.events || {};
  return Object.assign({}, definition, {
    props: Object.assign({}, definition.props, { navBarHidden: true, navButtons: [], debugging: false }),
    views: navigation.views(definition.views || []),
    events: Object.assign({}, events, {
      appeared: function (...args) {
        navigation.attach();
        if (events.appeared) return events.appeared.apply(this, args);
      },
      disappeared: function (...args) {
        navigation.hide();
        if (events.disappeared) return events.disappeared.apply(this, args);
      },
      dealloc: function (...args) {
        try { if (events.dealloc) return events.dealloc.apply(this, args); }
        finally { navigation.dispose(); }
      },
    }),
  });
}

module.exports = { accountButton, create, page };
