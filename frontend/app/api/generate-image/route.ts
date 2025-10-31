import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { prompt } = body

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 5) {
      return NextResponse.json(
        { error: 'Prompt is required and must be at least 5 characters long' },
        { status: 400 }
      )
    }

    // Get API key from environment variable
    const apiKey = process.env.OPENROUTER_API_KEY
    
    if (!apiKey) {
      console.error('OPENROUTER_API_KEY is not set in environment variables')
      return NextResponse.json(
        { error: 'Image generation service is not configured' },
        { status: 500 }
      )
    }

    // Call OpenRouter API
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash-image-preview',
        messages: [
          {
            role: 'user',
            content: `"${prompt}".`,
          },
        ],
        modalities: ['image', 'text'],
      }),
    })

    if (!response.ok) {
      const errorResult = await response.json()
      console.error('OpenRouter API error:', errorResult)
      return NextResponse.json(
        { error: errorResult.error?.message || `HTTP Error: ${response.status}` },
        { status: response.status }
      )
    }

    // Handle non-streaming response
    const result = await response.json()
    
    // The generated image will be in the assistant message
    let generatedImageUrl = null
    
    if (result.choices) {
      const message = result.choices[0].message
      
      if (message.images) {
        message.images.forEach((image: any) => {
          generatedImageUrl = image.image_url.url // Base64 data URL
        })
      }
    }

    if (!generatedImageUrl) {
      return NextResponse.json(
        { error: 'Image generation completed but no image was received. Please try again.' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      imageUrl: generatedImageUrl,
    })
  } catch (error: any) {
    console.error('Error generating image:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to generate image' },
      { status: 500 }
    )
  }
}

