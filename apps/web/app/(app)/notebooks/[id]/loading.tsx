// Shown at once while a notebook loads: the page's shape, so nothing jumps when it arrives.
export default function Loading() {
  return (
    <main id="inhalt" className="notebook">
      <div className="nb-head" role="status" aria-busy="true">
        <span className="sr-only">Wird geladen …</span>
        <div className="sk sk-title" />
      </div>
      <div className="nb-rail">
        <div className="sk sk-panel" />
        <div className="sk sk-panel short" />
      </div>
      <div className="chat">
        <div className="sk sk-chat" />
      </div>
    </main>
  );
}
