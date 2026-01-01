from PIL import Image, ImageDraw

def create_diamond(size, has_dot=False):
    # Create transparent image
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # Diamond coordinates
    # For size 22, diamond around 8-10px wide
    # For size 44, diamond around 16-20px wide
    margin = size // 4
    points = [
        (size // 2, margin),             # Top
        (size - margin, size // 2),      # Right
        (size // 2, size - margin),      # Bottom
        (margin, size // 2)              # Left
    ]
    
    draw.polygon(points, fill=(255, 255, 255, 255))
    
    if has_dot:
        dot_margin = max(2, size // 10)
        dot_size = max(3, size // 6)
        dot_pos = [
            size - dot_margin - dot_size,
            size - dot_margin - dot_size,
            size - dot_margin,
            size - dot_margin
        ]
        draw.ellipse(dot_pos, fill=(0, 255, 0, 255))
        
    return img

# Generate icons
create_diamond(22).save('tray_iconTemplate.png')
create_diamond(44).save('tray_iconTemplate@2x.png')
create_diamond(22, True).save('tray_icon_activeTemplate.png')
create_diamond(44, True).save('tray_icon_activeTemplate@2x.png')

print("Icons generated successfully.")
