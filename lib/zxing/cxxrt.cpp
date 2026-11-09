//
// cxxrt.cpp - the compiled pieces of the C++ and C libraries that
// zxing-cpp's QR code reader needs in the kernel and that Circle does not
// have (lib/zxing/Makefile; libstdc++'s tree.o and list.o are the others).
// Built like zxing-cpp: without exceptions or RTTI.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include <memory>
#include <string>
#include <typeinfo>
#include <stddef.h>
#include <string.h>
#include <wchar.h>
#include "gk_bridge.h"

// std::string: libstdc++ declares the instantiation for char extern (it is
// compiled into libstdc++.a, with exceptions). The one member function
// zxing-cpp's code does not get inlined, compiled here without them:
template void std::string::_M_replace_cold (char *, size_type, const char *, size_type, size_type);

// std::make_shared without RTTI compares against a tag (libstdc++'s
// shared_ptr.cc)
bool std::_Sp_make_shared_tag::_S_eq (const std::type_info &rTypeInfo) noexcept
{
	return &rTypeInfo == &_S_ti ();
}

// What the C++ library calls instead of throwing, as it is built without
// exceptions (vector::at out of range, a string too long, ...): a bug, not
// bad input (tests/fuzz/fuzz_qr.cpp), so the kernel stops, as on a failed
// assertion.
namespace std
{
	[[noreturn]] void __throw_bad_alloc (void)
	{
		gk_fatal ("QR decoder: C++ library: out of memory");
	}
	[[noreturn]] void __throw_bad_array_new_length (void)
	{
		gk_fatal ("QR decoder: C++ library: bad array new length");
	}
	[[noreturn]] void __throw_bad_function_call (void)
	{
		gk_fatal ("QR decoder: C++ library: bad function call");
	}
	[[noreturn]] void __throw_length_error (const char *)
	{
		gk_fatal ("QR decoder: C++ library: length error");
	}
	[[noreturn]] void __throw_logic_error (const char *)
	{
		gk_fatal ("QR decoder: C++ library: logic error");
	}
	[[noreturn]] void __throw_out_of_range_fmt (const char *, ...)
	{
		gk_fatal ("QR decoder: C++ library: out of range");
	}
}

// From the C library, which the kernel does not have (zxing-cpp's text
// conversion: GapKeep takes QR payloads as bytes, but the code is linked)
extern "C" int tolower (int c)
{
	return c >= 'A' && c <= 'Z' ? c - 'A' + 'a' : c;
}

extern "C" wchar_t *wmemcpy (wchar_t *pDest, const wchar_t *pSrc, size_t n)
{
	return (wchar_t *) memcpy (pDest, pSrc, n * sizeof (wchar_t));
}

extern "C" size_t wcslen (const wchar_t *p)
{
	size_t n = 0;
	while (p[n] != 0)
	{
		n++;
	}
	return n;
}
