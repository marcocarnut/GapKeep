// Fuzzes gk:zlib's decompression (src/runtime/inflate.c over zlib's
// inflate) with AddressSanitizer and UBSan: tools/fuzz_inflate.sh.
//
// The seeds (made by Python's zlib, read from a file): each must
// decompress to exactly its data, in any budget per step, and be refused
// as too big with a limit one byte short. Then each round mutates a seed
// (bits flipped, bytes inserted or deleted, cut short, stitched to
// another) and decompresses it with a random limit: any result is fine,
// but never more output than the limit, and never a memory error.
//
// SPDX-License-Identifier: GPL-3.0-or-later
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
extern "C" {
#include "inflate.h"
}

struct Seed
{
	int format;
	std::vector<uint8_t> data, stream;
};

static unsigned s_nRand;
static unsigned Rand (void)
{
	s_nRand = s_nRand * 1103515245 + 12345;
	return s_nRand >> 8;
}

static int Run (int format, const std::vector<uint8_t> &in, size_t max, size_t budget, std::vector<uint8_t> *out)
{
	gk_inflate_job_t job;
	if (gk_inflate_begin (&job, format, in.data (), in.size (), max) != 0)
	{
		return GK_INFLATE_NO_MEMORY;
	}
	unsigned steps = 0;
	while (gk_inflate_step (&job, budget))
	{
		if (++steps > 100000000)
		{
			fprintf (stderr, "fuzz_inflate: no end\n");
			abort ();
		}
	}
	uint8_t *p;
	size_t n;
	int r = gk_inflate_result (&job, &p, &n);
	if (r == 0)
	{
		if (n > max)
		{
			fprintf (stderr, "fuzz_inflate: %zu bytes out, the limit %zu\n", n, max);
			abort ();
		}
		if (out != 0) out->assign (p, p + n);
		gk_inflate_free_output (p);
	}
	gk_inflate_end (&job);
	return r;
}

static uint32_t Get32 (FILE *f)
{
	uint8_t b[4];
	if (fread (b, 1, 4, f) != 4) return 0xffffffff;
	return (uint32_t) b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3];
}

int main (int argc, char **argv)
{
	if (argc < 2)
	{
		fprintf (stderr, "usage: fuzz_inflate seeds [rounds] [seed]\n");
		return 2;
	}
	unsigned long nRounds = argc > 2 ? strtoul (argv[2], 0, 10) : 100000;
	s_nRand = argc > 3 ? (unsigned) strtoul (argv[3], 0, 10) : 1;

	// seeds: format (1 byte), data length, data, stream length, stream
	std::vector<Seed> seeds;
	FILE *f = fopen (argv[1], "rb");
	if (f == 0) { perror (argv[1]); return 2; }
	int c;
	while ((c = fgetc (f)) != EOF)
	{
		Seed s;
		s.format = c;
		uint32_t n = Get32 (f);
		s.data.resize (n);
		if (n && fread (s.data.data (), 1, n, f) != n) break;
		n = Get32 (f);
		s.stream.resize (n);
		if (n && fread (s.stream.data (), 1, n, f) != n) break;
		seeds.push_back (s);
	}
	fclose (f);

	// the seeds as they are
	for (const Seed &s : seeds)
	{
		std::vector<uint8_t> out;
		size_t budget = 1 + Rand () % 100000;
		if (Run (s.format, s.stream, s.data.size () ? s.data.size () : 1, budget, &out) != 0 || out != s.data)
		{
			fprintf (stderr, "fuzz_inflate: a seed (%zu bytes) did not decompress\n", s.data.size ());
			return 1;
		}
		if (s.data.size () > 1 && Run (s.format, s.stream, s.data.size () - 1, budget, 0) != GK_INFLATE_TOO_BIG)
		{
			fprintf (stderr, "fuzz_inflate: a seed's limit was not kept\n");
			return 1;
		}
	}
	printf ("fuzz_inflate: %zu seeds right\n", seeds.size ());

	// mutated
	unsigned long nOK = 0, nBad = 0, nBig = 0;
	for (unsigned long round = 0; round < nRounds; round++)
	{
		const Seed &s = seeds[Rand () % seeds.size ()];
		std::vector<uint8_t> in = s.stream;
		unsigned nMutations = 1 + Rand () % 4;
		for (unsigned m = 0; m < nMutations && !in.empty (); m++)
		{
			size_t at = Rand () % in.size ();
			switch (Rand () % 5)
			{
			case 0: in[at] ^= (uint8_t) (1 << (Rand () % 8)); break;
			case 1: in.insert (in.begin () + at, (uint8_t) Rand ()); break;
			case 2: in.erase (in.begin () + at); break;
			case 3: in.resize (at); break;
			case 4:
			{
				const Seed &o = seeds[Rand () % seeds.size ()];
				in.insert (in.end (), o.stream.begin (), o.stream.end ());
				break;
			}
			}
		}
		size_t max = 1 + Rand () % (2 * s.data.size () + 64);
		int r = Run (Rand () % 2, in, max, 1 + Rand () % 70000, 0);
		if (r == 0) nOK++;
		else if (r == GK_INFLATE_TOO_BIG) nBig++;
		else nBad++;
	}
	printf ("fuzz_inflate: %lu rounds: %lu decompressed, %lu too big, %lu refused\n", nRounds, nOK, nBig, nBad);
	return 0;
}
