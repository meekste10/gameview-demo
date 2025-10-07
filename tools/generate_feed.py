import json, random

# number of frames (e.g., 10 Hz * 12 seconds = 120 frames)
frames = []
for t in range(120):
    entities = []
    for pid in range(1, 23):  # 22 players
        team = 'GB' if pid <= 11 else 'CHI'
        entities.append({
            "id": f"P{pid}",
            "team": team,
            "x": random.uniform(0, 100),
            "y": random.uniform(0, 53.3),
            "z": 0,
            "speed": random.uniform(0, 20)
        })
    entities.append({
        "id": "BALL",
        "x": random.uniform(0, 100),
        "y": random.uniform(0, 53.3),
        "z": random.uniform(0, 5),
        "spin": random.uniform(3000, 5000)
    })
    frame = {
        "timestamp": f"2025-10-06T00:00:{t:02d}.0Z",
        "entities": entities
    }
    frames.append(frame)

# write as JSON Lines
with open("synthetic_feed.jsonl", "w") as f:
    for frame in frames:
        f.write(json.dumps(frame) + "\n")

print("✅ synthetic_feed.jsonl created with", len(frames), "frames.")
