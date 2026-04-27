from PIL import Image

# Load the new_icon
img = Image.open('new_icon.png').convert('RGBA')

# Trim whitespace - autocrop with threshold
def trim_transparency(im):
    """Remove transparency padding and white background."""
    bbox = im.getbbox()
    if bbox:
        return im.crop(bbox)
    return im

trimmed = trim_transparency(img)

# Function to create icon with padding
def create_icon(source_img, size):
    # Resize while maintaining aspect ratio
    source_img.thumbnail((size, size), Image.Resampling.LANCZOS)
    # Create new image with transparent background
    final = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    # Center the image
    offset = ((size - source_img.width) // 2, (size - source_img.height) // 2)
    final.paste(source_img, offset, source_img)
    return final

# Generate icon sizes
sizes = [16, 32, 48, 128]
for size in sizes:
    icon = create_icon(trimmed.copy(), size)
    icon.save(f'icon{size}.png')
    print(f'Created icon{size}.png')

print('Icon generation complete')
