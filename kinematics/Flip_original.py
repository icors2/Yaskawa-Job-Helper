# REFERENCE COPY ? production math: kinematics/frame_flip.py (sidecar + CLI).
# App UI: Transform -> Frame convert (Flip). Workspace original: ../Flip.py
# ---------------------------------------------------------------------------
import re
import numpy as np

# ==============================================================================
# 1. ENTER THE DATA YOU FOUND ON THE PENDANT HERE (X, Y, Z, Rx, Ry, Rz)
# ==============================================================================
UF1_DATA = [1000.00, 0.00, 500.00, 0.0000, 0.0000, 0.0000]   # Source Frame
UF2_DATA = [1500.00, 200.00, 500.00, 0.0000, 0.0000, 180.0000] # Target Frame (Inverted)

INPUT_JBI_FILE = "ORIGINAL_JOB.JBI"
OUTPUT_JBI_FILE = "CONVERTED_JOB.JBI"
TARGET_NEW_UF_NUMBER = 2  # Changes the header token to look at UF#(2)

# ==============================================================================
# MATRIX CONVERSION ENGINE (Yaskawa Intrinsic Z-Y-X Euler Sequence)
# ==============================================================================
def euref_to_matrix(x, y, z, rx, ry, rz):
    ax, ay, az = np.radians([rx, ry, rz])
    Rx = np.array([[1, 0, 0], [0, np.cos(ax), -np.sin(ax)], [0, np.sin(ax), np.cos(ax)]])
    Ry = np.array([[np.cos(ay), 0, np.sin(ay)], [0, 1, 0], [-np.sin(ay), 0, np.cos(ay)]])
    Rz = np.array([[np.cos(az), -np.sin(az), 0], [np.sin(az), np.cos(az), 0], [0, 0, 1]])
    R = Rz @ Ry @ Rx
    M = np.eye(4)
    M[0:3, 0:3], M[0:3, 3] = R, [x, y, z]
    return M

def matrix_to_euref(M):
    x, y, z = M[0:3, 3]
    R = M[0:3, 0:3]
    ay = np.arctan2(-R[2, 0], np.sqrt(R[0, 0]**2 + R[1, 0]**2))
    if np.abs(np.cos(ay)) > 1e-6:
        az = np.arctan2(R[1, 0], R[0, 0])
        ax = np.arctan2(R[2, 1], R[2, 2])
    else:
        az = 0
        ax = np.arctan2(-R[0, 1], R[1, 1])
    return [x, y, z, np.degrees(ax), np.degrees(ay), np.degrees(az)]

# Calculate global frame relationships
M_uf1 = euref_to_matrix(*UF1_DATA)
M_uf2 = euref_to_matrix(*UF2_DATA)

# Tool Flip Matrix (180deg clean flip around tool Z-axis to stop /OV errors)
R_flip = np.eye(4)
R_flip[0:3, 0:3] = np.array([[-1, 0, 0], [0, -1, 0], [0, 0, 1]])

# ==============================================================================
# FILE PARSER (Reads .JBI, updates positions, outputs new file)
# ==============================================================================
with open(INPUT_JBI_FILE, "r") as f:
    lines = f.readlines()

new_lines = []
for line in lines:
    # 1. Update User Frame Target in Header
    if line.startswith("///USER"):
        new_lines.append(f"///USER {TARGET_NEW_UF_NUMBER}\n")
        continue
        
    # 2. Find position variables (Format: C00000=X,Y,Z,Rx,Ry,Rz)
    match = re.match(r"(C\d+=)(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+),(-?\d+\.\d+)(.*)", line)
    if match:
        prefix = match.group(1)
        coords = [float(match.group(i)) for i in range(2, 8)]
        suffix = match.group(8)
        
        # Apply Frame shift & local tool orientation rotation
        M_p_old = euref_to_matrix(*coords)
        M_p_new = np.linalg.inv(M_uf2) @ M_uf1 @ M_p_old
        M_p_final = M_p_new @ R_flip # Bypasses wrist-twist faults
        
        final_coords = matrix_to_euref(M_p_final)
        coord_str = ",".join(f"{c:.3f}" for c in final_coords)
        new_lines.append(f"{prefix}{coord_str}{suffix}\n")
    else:
        new_lines.append(line)

with open(OUTPUT_JBI_FILE, "w") as f:
    f.writelines(new_lines)

print("Conversion finished! Converted file ready to load via USB.")
print("Prefer: python kinematics/frame_flip.py ... or Transform UI (Frame convert Flip).")
