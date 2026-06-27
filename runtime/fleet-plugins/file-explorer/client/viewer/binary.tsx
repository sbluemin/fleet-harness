interface BinaryViewerProps {
  readonly name: string;
  readonly sizeHint?: string;
}

export function BinaryViewer({ name, sizeHint }: BinaryViewerProps) {
  return (
    <div className="fexp-bin-wrap v-bin">
      <span className="fexp-bin-glyph" aria-hidden="true">⊘</span>
      <p className="fexp-bin-name">{name}</p>
      {sizeHint && <p className="fexp-bin-meta">{sizeHint}</p>}
      <p className="fexp-bin-hint">바이너리 파일은 미리 볼 수 없습니다</p>
    </div>
  );
}
