use std::time::{SystemTime, UNIX_EPOCH};

pub fn rc4_encrypt(plaintext: &[u8], key: &[u8]) -> Vec<u8> {
    let mut s = [0u8; 256];
    for (i, slot) in s.iter_mut().enumerate() {
        *slot = i as u8;
    }
    let mut j: u8 = 0;
    for i in 0..256 {
        j = j.wrapping_add(s[i]).wrapping_add(key[i % key.len()]);
        s.swap(i, j as usize);
    }
    let mut i: u8 = 0;
    j = 0;
    let mut out = Vec::with_capacity(plaintext.len());
    for &byte in plaintext {
        i = i.wrapping_add(1);
        j = j.wrapping_add(s[i as usize]);
        s.swap(i as usize, j as usize);
        let t = s[i as usize].wrapping_add(s[j as usize]);
        out.push(s[t as usize] ^ byte);
    }
    out
}

const SM3_IV: [u32; 8] = [
    0x7380166F, 0x4914B2B9, 0x172442D7, 0xDA8A0600, 0xA96F30BC, 0x163138AA, 0xE38DEE4D,
    0xB0FB0E4E,
];

#[inline]
fn sm3_ff(x: u32, y: u32, z: u32, j: usize) -> u32 {
    if j < 16 {
        x ^ y ^ z
    } else {
        (x & y) | (x & z) | (y & z)
    }
}

#[inline]
fn sm3_gg(x: u32, y: u32, z: u32, j: usize) -> u32 {
    if j < 16 {
        x ^ y ^ z
    } else {
        (x & y) | ((!x) & z)
    }
}

#[inline]
fn sm3_p0(x: u32) -> u32 {
    x ^ x.rotate_left(9) ^ x.rotate_left(17)
}

#[inline]
fn sm3_p1(x: u32) -> u32 {
    x ^ x.rotate_left(15) ^ x.rotate_left(23)
}

fn sm3_compress(state: &mut [u32; 8], block: &[u8]) {
    let mut w = [0u32; 68];
    let mut w_prime = [0u32; 64];
    for i in 0..16 {
        w[i] = u32::from_be_bytes([
            block[i * 4],
            block[i * 4 + 1],
            block[i * 4 + 2],
            block[i * 4 + 3],
        ]);
    }
    for i in 16..68 {
        w[i] = sm3_p1(w[i - 16] ^ w[i - 9] ^ w[i - 3].rotate_left(15))
            ^ w[i - 13].rotate_left(7)
            ^ w[i - 6];
    }
    for i in 0..64 {
        w_prime[i] = w[i] ^ w[i + 4];
    }

    let mut a = *state;
    for i in 0..64 {
        let tj: u32 = if i < 16 { 0x79CC4519 } else { 0x7A879D8A };
        let ss1 = a[0]
            .rotate_left(12)
            .wrapping_add(a[4])
            .wrapping_add(tj.rotate_left((i % 32) as u32))
            .rotate_left(7);
        let ss2 = ss1 ^ a[0].rotate_left(12);
        let tt1 = sm3_ff(a[0], a[1], a[2], i)
            .wrapping_add(a[3])
            .wrapping_add(ss2)
            .wrapping_add(w_prime[i]);
        let tt2 = sm3_gg(a[4], a[5], a[6], i)
            .wrapping_add(a[7])
            .wrapping_add(ss1)
            .wrapping_add(w[i]);

        a[3] = a[2];
        a[2] = a[1].rotate_left(9);
        a[1] = a[0];
        a[0] = tt1;
        a[7] = a[6];
        a[6] = a[5].rotate_left(19);
        a[5] = a[4];
        a[4] = sm3_p0(tt2);
    }

    for i in 0..8 {
        state[i] ^= a[i];
    }
}

pub fn sm3_hash(data: &[u8]) -> [u8; 32] {
    let mut state = SM3_IV;
    let mut buf = data.to_vec();
    let total_bits = (data.len() as u64).wrapping_mul(8);
    buf.push(0x80);
    while buf.len() % 64 != 56 {
        buf.push(0);
    }
    buf.extend_from_slice(&total_bits.to_be_bytes());
    for chunk in buf.chunks_exact(64) {
        sm3_compress(&mut state, chunk);
    }
    let mut out = [0u8; 32];
    for (i, word) in state.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

const S4: &[u8] = b"Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe=";
const S3: &[u8] = b"ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe";
const WINDOW_ENV_STR: &str = "1536|747|1536|834|0|30|0|0|1536|834|1536|864|1525|747|24|24|Win32";

fn custom_base64_encode(data: &[u8], table: &[u8]) -> String {
    let mut result = String::with_capacity((data.len() / 3 + 1) * 4);
    let pad = data.len() % 3;
    let main_len = data.len() - pad;

    for chunk in data[..main_len].chunks_exact(3) {
        let n = ((chunk[0] as usize) << 16) | ((chunk[1] as usize) << 8) | (chunk[2] as usize);
        result.push(table[(n >> 18) & 0x3F] as char);
        result.push(table[(n >> 12) & 0x3F] as char);
        result.push(table[(n >> 6) & 0x3F] as char);
        result.push(table[n & 0x3F] as char);
    }

    if pad == 1 {
        let n = (data[main_len] as usize) << 16;
        result.push(table[(n >> 18) & 0x3F] as char);
        result.push(table[(n >> 12) & 0x3F] as char);
        result.push('=');
        result.push('=');
    } else if pad == 2 {
        let n = ((data[main_len] as usize) << 16) | ((data[main_len + 1] as usize) << 8);
        result.push(table[(n >> 18) & 0x3F] as char);
        result.push(table[(n >> 12) & 0x3F] as char);
        result.push(table[(n >> 6) & 0x3F] as char);
        result.push('=');
    }

    result
}

#[inline]
fn mix_random_byte(value: u64, value_mask: u8, salt: u8, salt_mask: u8) -> u8 {
    (((value as u8) & value_mask) | (salt & salt_mask)) & 0xFF
}

fn generate_random_bytes() -> [u8; 12] {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let r1 = ((now & 0xFFFF_FFFF).wrapping_mul(10000)) % 10000;
    let r2 = (((now >> 32) & 0xFFFF_FFFF).wrapping_mul(10000)) % 10000;
    let r3 = (((now >> 16) & 0xFFFF_FFFF).wrapping_mul(10000)) % 10000;

    [
        mix_random_byte(r1, 0xAA, 3, 0x55),
        mix_random_byte(r1, 0x55, 3, 0xAA),
        mix_random_byte(r1 >> 8, 0xAA, 45, 0x55),
        mix_random_byte(r1 >> 8, 0x55, 45, 0xAA),
        mix_random_byte(r2, 0xAA, 1, 0x55),
        mix_random_byte(r2, 0x55, 1, 0xAA),
        mix_random_byte(r2 >> 8, 0xAA, 0, 0x55),
        mix_random_byte(r2 >> 8, 0x55, 0, 0xAA),
        mix_random_byte(r3, 0xAA, 1, 0x55),
        mix_random_byte(r3, 0x55, 1, 0xAA),
        mix_random_byte(r3 >> 8, 0xAA, 5, 0x55),
        mix_random_byte(r3 >> 8, 0x55, 5, 0xAA),
    ]
}

fn generate_rc4_bb(params: &str, user_agent: &str, args: [u32; 3]) -> Vec<u8> {
    let start_time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let params_hash2 = sm3_hash(&sm3_hash(params.as_bytes()));
    let cus_hash2 = sm3_hash(&sm3_hash(b"cus"));

    let ua_key = [0u8, 1u8, (args[2] & 0xFF) as u8];
    let ua_encrypted = rc4_encrypt(user_agent.as_bytes(), &ua_key);
    let ua_encoded = custom_base64_encode(&ua_encrypted, S3);
    let ua_hash = sm3_hash(ua_encoded.as_bytes());

    let end_time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(start_time);

    let mut b = [0u8; 73];
    b[8] = 3;

    b[44] = ((end_time >> 24) & 0xFF) as u8;
    b[45] = ((end_time >> 16) & 0xFF) as u8;
    b[46] = ((end_time >> 8) & 0xFF) as u8;
    b[47] = (end_time & 0xFF) as u8;

    b[20] = ((start_time >> 24) & 0xFF) as u8;
    b[21] = ((start_time >> 16) & 0xFF) as u8;
    b[22] = ((start_time >> 8) & 0xFF) as u8;
    b[23] = (start_time & 0xFF) as u8;

    b[26] = ((args[0] >> 24) & 0xFF) as u8;
    b[27] = ((args[0] >> 16) & 0xFF) as u8;
    b[28] = ((args[0] >> 8) & 0xFF) as u8;
    b[29] = (args[0] & 0xFF) as u8;

    b[34] = ((args[2] >> 24) & 0xFF) as u8;
    b[35] = ((args[2] >> 16) & 0xFF) as u8;
    b[36] = ((args[2] >> 8) & 0xFF) as u8;
    b[37] = (args[2] & 0xFF) as u8;

    b[38] = params_hash2[21];
    b[39] = params_hash2[22];
    b[40] = cus_hash2[21];
    b[41] = cus_hash2[22];
    b[42] = ua_hash[23];
    b[43] = ua_hash[24];

    b[18] = 44;
    b[51] = ((6241u32 >> 8) & 0xFF) as u8;
    b[56] = (6383u32 & 0xFF) as u8;
    b[57] = (6383u32 & 0xFF) as u8;
    b[58] = ((6383u32 >> 8) & 0xFF) as u8;

    let env_bytes = WINDOW_ENV_STR.as_bytes();
    b[64] = (env_bytes.len() & 0xFF) as u8;
    b[65] = (env_bytes.len() & 0xFF) as u8;

    b[72] = b[18]
        ^ b[20]
        ^ b[26]
        ^ b[30]
        ^ b[38]
        ^ b[40]
        ^ b[42]
        ^ b[21]
        ^ b[27]
        ^ b[31]
        ^ b[35]
        ^ b[39]
        ^ b[41]
        ^ b[43]
        ^ b[22]
        ^ b[28]
        ^ b[32]
        ^ b[36]
        ^ b[23]
        ^ b[29]
        ^ b[33]
        ^ b[37]
        ^ b[44]
        ^ b[45]
        ^ b[46]
        ^ b[47]
        ^ b[48]
        ^ b[49]
        ^ b[50]
        ^ b[24]
        ^ b[25]
        ^ b[52]
        ^ b[53]
        ^ b[54]
        ^ b[55]
        ^ b[57]
        ^ b[58]
        ^ b[59]
        ^ b[60]
        ^ b[65]
        ^ b[66]
        ^ b[70]
        ^ b[71];

    let mut bb = Vec::with_capacity(160);
    bb.push(b[18]);
    bb.push(b[20]);
    bb.extend_from_slice(&b[52..55]);
    bb.extend_from_slice(&b[26..59]);
    bb.extend_from_slice(&b[38..44]);
    bb.extend_from_slice(&b[21..23]);
    bb.extend_from_slice(&b[27..38]);
    bb.extend_from_slice(&b[44..61]);
    bb.extend_from_slice(&b[24..26]);
    bb.extend_from_slice(&b[65..67]);
    bb.extend_from_slice(&b[70..72]);
    bb.extend_from_slice(env_bytes);
    bb.push(b[72]);

    rc4_encrypt(&bb, &[121u8])
}

pub fn sign_detail(params: &str, user_agent: &str) -> String {
    let rand_bytes = generate_random_bytes();
    let rc4_data = generate_rc4_bb(params, user_agent, [0, 1, 14]);
    let mut combined = Vec::with_capacity(rand_bytes.len() + rc4_data.len());
    combined.extend_from_slice(&rand_bytes);
    combined.extend_from_slice(&rc4_data);
    let mut encoded = custom_base64_encode(&combined, S4);
    encoded.push('=');
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sm3_standard_vector_abc() {
        // GB/T 32905-2016 标准测试向量 SM3("abc")
        let digest = sm3_hash(b"abc");
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            hex,
            "66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0"
        );
    }

    #[test]
    fn a_bogus_generates_non_empty_token() {
        let token = sign_detail(
            "aweme_id=7300000000000000000&device_platform=webapp&aid=6383",
            "Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36",
        );
        assert!(token.len() > 100);
        assert!(token.ends_with('='));
    }
}
