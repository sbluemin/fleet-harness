interface ImageViewerProps {
  readonly src: string;
  readonly name: string;
}

export function ImageViewer({ src, name }: ImageViewerProps) {
  return (
    <div className="fexp-img-wrap">
      <div className="fexp-img-stage">
        <img
          src={src}
          alt={name}
          className="fexp-img"
          draggable={false}
        />
      </div>
      <figcaption className="fexp-img-caption">{name}</figcaption>
    </div>
  );
}
