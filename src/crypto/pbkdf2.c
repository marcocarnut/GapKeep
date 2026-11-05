/*
 * pbkdf2.c - PBKDF2 (RFC 8018, 5.2), written from the RFC.
 *
 * The HMAC key (the password) is the same in every iteration, so its
 * padded blocks are hashed once (zg_hmac_init) and the state copied: two
 * compressions per iteration for short blocks, instead of four.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "pbkdf2.h"
#include "hexcheck.h"
#include <string.h>

void zg_pbkdf2 (const zg_hash_t *hash, const void *password, size_t passlen,
		const void *salt, size_t saltlen, uint32_t iterations,
		uint8_t *out, size_t outlen)
{
	zg_hmac_t keyed, mac;
	uint8_t u[ZG_HASH_MAX_DIGEST], t[ZG_HASH_MAX_DIGEST];
	size_t hlen = hash->digest_size;

	zg_hmac_init (&keyed, hash, password, passlen);

	for (uint32_t block = 1; outlen > 0; block++)
	{
		uint8_t index[4] = { (uint8_t) (block >> 24), (uint8_t) (block >> 16),
				     (uint8_t) (block >> 8), (uint8_t) block };

		/* U_1 = PRF (P, S || INT (i)) */
		mac = keyed;
		zg_hmac_update (&mac, salt, saltlen);
		zg_hmac_update (&mac, index, sizeof index);
		zg_hmac_final (&mac, u);
		memcpy (t, u, hlen);

		/* U_j = PRF (P, U_{j-1}); T = U_1 ^ ... ^ U_c */
		for (uint32_t j = 1; j < iterations; j++)
		{
			mac = keyed;
			zg_hmac_update (&mac, u, hlen);
			zg_hmac_final (&mac, u);
			for (size_t k = 0; k < hlen; k++)
			{
				t[k] ^= u[k];
			}
		}

		size_t n = outlen < hlen ? outlen : hlen;
		memcpy (out, t, n);
		out += n;
		outlen -= n;
	}

	memset (&keyed, 0, sizeof keyed);
	memset (&mac, 0, sizeof mac);
	memset (u, 0, sizeof u);
	memset (t, 0, sizeof t);
}

int zg_pbkdf2_selftest (int full)
{
	static const struct
	{
		const zg_hash_t *hash;
		const char *password; size_t passlen;
		const char *salt; size_t saltlen;
		uint32_t iterations;
		const char *hex;
	}
	v[] =
	{
		/* RFC 6070 */
		{ &zg_hash_sha1, "password", 8, "salt", 4, 1, "0c60c80f961f0e71f3a9b524af6012062fe037a6" },
		{ &zg_hash_sha1, "password", 8, "salt", 4, 2, "ea6c014dc72d6f8ccd1ed92ace1d41f0d8de8957" },
		{ &zg_hash_sha1, "pass\0word", 9, "sa\0lt", 5, 4096, "56fa6aa75548099dcc37d7f03425e0c3" },
		/* several blocks, the last one cut short */
		{ &zg_hash_sha1, "passwordPASSWORDpassword", 24, "saltSALTsaltSALTsaltSALTsaltSALTsalt", 36, 4096,
		  "3d2eec4fe41c849b80c8d83662c0e44a8b291a964cf2f07038" },
		{ &zg_hash_sha256, "password", 8, "salt", 4, 3,
		  "ad35240ac683febfaf3cd49d845473fbbbaa2437f5f82d5a415ae00ac76c6bfc"
		  "cf9a9b8d6d2fe4a1e700c4460b040dbed692c1cb85a747f35588c08930fcfc41"
		  "ac48082086069b111a9c752f1856237f3af8adc86757f26c60870d3eb52a7c20"
		  "60c3749b" },
		{ &zg_hash_sha512, "password", 8, "salt", 4, 2,
		  "e1d9c16aa681708a45f5c7c4e215ceb66e011a2e9f0040713f18aefdb866d53c"
		  "f76cab2868a39b9f7840edce4fef5a82be67335c77a6068e04112754f27ccf4e" },
		/* BIP-39, first vector, passphrase "TREZOR" */
		{ &zg_hash_sha512,
		  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", 93,
		  "mnemonicTREZOR", 14, 2048,
		  "c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e5349553"
		  "1f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04" },
	};
	uint8_t d[100];

	for (unsigned i = 0; i < sizeof v / sizeof v[0]; i++)
	{
		if (v[i].iterations == 4096 && !full)
		{
			continue;
		}
		size_t len = strlen (v[i].hex) / 2;
		zg_pbkdf2 (v[i].hash, v[i].password, v[i].passlen, v[i].salt, v[i].saltlen,
			   v[i].iterations, d, len);
		if (!zg_hex_equal (d, len, v[i].hex))
		{
			return (int) i + 1;
		}
	}
	return 0;
}
