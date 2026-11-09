//
// session.cpp
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "session.h"
#include <circle/util.h>

struct TGkSessionEntry
{
	TGkSessionEntry *pNext;
	char *pOwner;
	char *pKey;
	u8 *pData;
	size_t nSize;			// of pData
	size_t nCost;			// counted against the limits: key + data
};

TGkSessionEntry *CGkSession::s_pFirst = 0;
size_t CGkSession::s_nTotal = 0;

static char *CopyString (const char *p)
{
	size_t n = strlen (p) + 1;
	char *q = new char[n];
	memcpy (q, p, n);
	return q;
}

static void WipeDelete (void *p, size_t n)
{
	if (p != 0)
	{
		// volatile: the compiler may not drop stores to memory about to be freed
		volatile u8 *v = (volatile u8 *) p;
		while (n-- > 0)
		{
			*v++ = 0;
		}
		delete [] (u8 *) p;
	}
}

void CGkSession::Free (TGkSessionEntry *pEntry)
{
	WipeDelete (pEntry->pOwner, strlen (pEntry->pOwner) + 1);
	WipeDelete (pEntry->pKey, strlen (pEntry->pKey) + 1);
	WipeDelete (pEntry->pData, pEntry->nSize);
	s_nTotal -= pEntry->nCost;
	delete pEntry;
}

TGkSessionEntry *CGkSession::Find (const char *pOwner, const char *pKey, TGkSessionEntry ***pppLink)
{
	for (TGkSessionEntry **pp = &s_pFirst; *pp != 0; pp = &(*pp)->pNext)
	{
		if (   strcmp ((*pp)->pOwner, pOwner) == 0
		    && strcmp ((*pp)->pKey, pKey) == 0)
		{
			if (pppLink != 0)
			{
				*pppLink = pp;
			}
			return *pp;
		}
	}
	return 0;
}

CGkSession::TResult CGkSession::Set (const char *pOwner, const char *pKey, const void *pData, size_t nSize)
{
	TGkSessionEntry **ppLink;
	TGkSessionEntry *pOld = Find (pOwner, pKey, &ppLink);
	size_t nOldCost = pOld != 0 ? pOld->nCost : 0;
	size_t nCost = strlen (pKey) + nSize;

	if (GetUsed (pOwner) - nOldCost + nCost > MaxPerApp)
	{
		return TooBig;
	}
	if (s_nTotal - nOldCost + nCost > MaxTotal)
	{
		return Full;
	}

	u8 *pCopy = new u8[nSize ? nSize : 1];
	memcpy (pCopy, pData, nSize);

	if (pOld != 0)
	{
		// keep the key's place in the order
		WipeDelete (pOld->pData, pOld->nSize);
		pOld->pData = pCopy;
		pOld->nSize = nSize;
		s_nTotal = s_nTotal - nOldCost + nCost;
		pOld->nCost = nCost;
		return Ok;
	}

	TGkSessionEntry *pEntry = new TGkSessionEntry;
	pEntry->pNext = 0;
	pEntry->pOwner = CopyString (pOwner);
	pEntry->pKey = CopyString (pKey);
	pEntry->pData = pCopy;
	pEntry->nSize = nSize;
	pEntry->nCost = nCost;
	s_nTotal += nCost;

	TGkSessionEntry **pp = &s_pFirst;
	while (*pp != 0)
	{
		pp = &(*pp)->pNext;
	}
	*pp = pEntry;

	return Ok;
}

const u8 *CGkSession::Get (const char *pOwner, const char *pKey, size_t *pSize)
{
	TGkSessionEntry *pEntry = Find (pOwner, pKey, 0);
	if (pEntry == 0)
	{
		return 0;
	}
	*pSize = pEntry->nSize;
	return pEntry->pData;
}

boolean CGkSession::Remove (const char *pOwner, const char *pKey)
{
	TGkSessionEntry **ppLink;
	TGkSessionEntry *pEntry = Find (pOwner, pKey, &ppLink);
	if (pEntry == 0)
	{
		return FALSE;
	}
	*ppLink = pEntry->pNext;
	Free (pEntry);
	return TRUE;
}

void CGkSession::Clear (const char *pOwner)
{
	TGkSessionEntry **pp = &s_pFirst;
	while (*pp != 0)
	{
		TGkSessionEntry *pEntry = *pp;
		if (strcmp (pEntry->pOwner, pOwner) == 0)
		{
			*pp = pEntry->pNext;
			Free (pEntry);
		}
		else
		{
			pp = &pEntry->pNext;
		}
	}
}

const char *CGkSession::NextKey (const char *pOwner, const char *pKey)
{
	TGkSessionEntry *p = s_pFirst;
	if (pKey != 0)
	{
		p = Find (pOwner, pKey, 0);
		if (p == 0)
		{
			return 0;
		}
		p = p->pNext;
	}
	for (; p != 0; p = p->pNext)
	{
		if (strcmp (p->pOwner, pOwner) == 0)
		{
			return p->pKey;
		}
	}
	return 0;
}

size_t CGkSession::GetUsed (const char *pOwner)
{
	size_t n = 0;
	for (TGkSessionEntry *p = s_pFirst; p != 0; p = p->pNext)
	{
		if (strcmp (p->pOwner, pOwner) == 0)
		{
			n += p->nCost;
		}
	}
	return n;
}
