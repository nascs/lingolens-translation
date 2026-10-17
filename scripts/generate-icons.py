from pathlib import Path

from PIL import Image, ImageDraw


output = Path("public/icons")
output.mkdir(parents=True, exist_ok=True)

for size in (16, 32, 48, 128):
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=max(3, size // 4), fill="#20342e")
    draw.ellipse(
        (size * 0.19, size * 0.19, size * 0.73, size * 0.73),
        outline="#f5d5b8",
        width=max(1, size // 12),
    )
    draw.line(
        (size * 0.30, size * 0.69, size * 0.70, size * 0.31),
        fill="#f5d5b8",
        width=max(1, size // 11),
    )
    draw.ellipse((size * 0.68, size * 0.17, size * 0.88, size * 0.37), fill="#ef7456")
    image.save(output / f"icon-{size}.png")
