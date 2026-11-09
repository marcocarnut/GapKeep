// Stand-in for Circle's CString (the members GapKeep uses), on the host C
// library's vsnprintf.
#ifndef _circle_string_h
#define _circle_string_h
#include <circle/types.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

class CString
{
public:
	CString (void)				{ Set ("", 0); }
	CString (const char *pString)		{ Set (pString, strlen (pString)); }
	CString (const CString &rString)	{ Set (rString.m_p, rString.m_n); }
	~CString (void)				{ free (m_p); }

	operator const char *(void) const	{ return m_p; }
	const char *operator = (const char *pString)
		{ char *p = Dup (pString, strlen (pString)); free (m_p); m_p = p; m_n = strlen (p); return m_p; }
	CString &operator = (const CString &rString)
		{ if (this != &rString) { free (m_p); Set (rString.m_p, rString.m_n); } return *this; }
	CString &operator += (const char chChar)	{ Append (chChar); return *this; }
	CString &operator += (const char *pString)	{ Append (pString); return *this; }
	CString &operator += (const CString &rString)	{ Append (rString.m_p); return *this; }

	size_t GetLength (void) const		{ return m_n; }

	void Append (const char *pString)
	{
		size_t n = strlen (pString);
		m_p = (char *) realloc (m_p, m_n + n + 1);
		memcpy (m_p + m_n, pString, n + 1);
		m_n += n;
	}
	void Append (const char chChar)		{ char s[2] = {chChar, 0}; Append (s); }

	int Compare (const char *pString) const	{ return strcmp (m_p, pString); }
	int Find (char chChar) const		{ const char *p = strchr (m_p, chChar); return p ? (int) (p - m_p) : -1; }

	void Format (const char *pFormat, ...) __attribute__ ((format (printf, 2, 3)))
		{ va_list a; va_start (a, pFormat); FormatV (pFormat, a); va_end (a); }
	void FormatV (const char *pFormat, va_list Args)
	{
		va_list Copy;
		va_copy (Copy, Args);
		int n = vsnprintf (0, 0, pFormat, Copy);
		va_end (Copy);
		char *p = (char *) malloc (n + 1);
		vsnprintf (p, n + 1, pFormat, Args);
		free (m_p);
		m_p = p;
		m_n = n;
	}

private:
	static char *Dup (const char *p, size_t n)
		{ char *q = (char *) malloc (n + 1); memcpy (q, p, n); q[n] = 0; return q; }
	void Set (const char *p, size_t n)	{ m_p = Dup (p, n); m_n = n; }

	char *m_p;
	size_t m_n;
};
#endif
